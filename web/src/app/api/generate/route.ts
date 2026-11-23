import { describeApiError } from "@/lib/claude";
import { generateImage } from "@/lib/generator";
import { critique, planPrompts, suggestOptions } from "@/lib/pipeline";
import {
  createRun,
  NotFoundError,
  readReferenceImages,
  saveGeneratedImage,
  updateProject,
  updateRun,
  type Run,
} from "@/lib/store";
import { ASPECTS, GenerateRequestSchema, type Answer, type GenerateEvent, type Generation, type RunInfo } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 800;

function info(run: Run): RunInfo {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { generations, ...rest } = run;
  return rest;
}

/**
 * Stage 3: write prompts, generate, self-check against the references, rewrite the prompt and regenerate
 * until the image passes or the round limit is reached. Every image and review is saved to the project's
 * history as it happens; progress streams back as NDJSON events.
 */
export async function POST(req: Request) {
  const parsed = GenerateRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid generate request.", details: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;
  const { settings } = input;

  let project;
  try {
    project = await updateProject(input.projectId, (p) => {
      p.answers = input.answers;
      p.settings = settings;
    });
  } catch (err) {
    if (err instanceof NotFoundError) return Response.json({ error: "Project not found." }, { status: 404 });
    throw err;
  }
  const analysis = project.analysis;
  if (!analysis) return Response.json({ error: "Analyse the images first." }, { status: 409 });

  const answers: Answer[] = project.questions.map((q) => ({
    question: q.question,
    answer: input.answers[q.id]?.trim() || `(skipped; assume: ${q.default_answer})`,
  }));
  const images = await readReferenceImages(project);
  const [width, height] = ASPECTS[settings.aspect];
  const projectId = project.id;
  const run = await createRun(projectId, { direction: input.direction, basePrompt: input.basePrompt, settings });
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: GenerateEvent) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          // browser went away; keep saving to history anyway until we notice the abort
        }
      };
      const finals: { title: string; prompt: string; score?: number; missing?: string[] }[] = [];
      let status: RunInfo["status"] = "done";

      try {
        send({ type: "run", run: info(run) });
        send({ type: "status", message: "Writing prompts from your images and answers…" });
        const plans = await planPrompts({
          images,
          analysis,
          answers,
          count: settings.count,
          direction: input.direction,
          basePrompt: input.basePrompt,
        });
        await updateRun(projectId, run.id, (r) => void (r.plans = plans));
        send({ type: "plans", runId: run.id, plans });

        for (const [variant, plan] of plans.entries()) {
          if (req.signal.aborted) break;
          const seed = Math.floor(Math.random() * 2 ** 31);
          let prompt = plan.prompt;
          let negativePrompt = plan.negative_prompt;
          let last: Generation | undefined;

          for (let round = 1; round <= settings.maxRounds; round++) {
            if (req.signal.aborted) break;
            send({ type: "status", message: `“${plan.title}”: generating round ${round}…` });
            const img = await generateImage({
              prompt,
              negativePrompt,
              width,
              height,
              seed, // same seed each round, so changes come from the corrected prompt
              initImage: settings.useReference ? images[0] : undefined,
              strength: settings.useReference ? settings.referenceStrength : undefined,
            });

            const generation: Generation = {
              id: `${run.id.slice(0, 8)}-v${variant}-r${round}`,
              runId: run.id,
              variant,
              variantTitle: plan.title,
              round,
              prompt,
              negativePrompt,
              seed: img.seed,
              backend: img.backend,
              image: await saveGeneratedImage(projectId, img.data),
              checklist: plan.checklist,
              createdAt: new Date().toISOString(),
            };
            await updateRun(projectId, run.id, (r) => void r.generations.push(generation));
            await updateProject(projectId, (p) => void (p.imageCount += 1));
            send({ type: "generation", generation });
            last = generation;

            send({ type: "status", message: `“${plan.title}”: checking round ${round} against your references…` });
            const review = await critique({
              images,
              analysis,
              answers,
              plan: { prompt, negativePrompt, checklist: plan.checklist },
              generated: { mediaType: img.mediaType, data: img.data },
              round,
              maxRounds: settings.maxRounds,
            });
            generation.critique = review;
            await updateRun(projectId, run.id, (r) => {
              const g = r.generations.find((x) => x.id === generation.id);
              if (g) g.critique = review;
            });
            await updateProject(projectId, (p) => {
              if (review.score > p.coverScore) {
                p.cover = generation.image;
                p.coverScore = review.score;
              }
            });
            send({ type: "critique", runId: run.id, id: generation.id, critique: review });

            if (review.verdict === "accept" || review.score >= settings.targetScore) break;
            prompt = review.revised_prompt || prompt;
            negativePrompt = review.revised_negative_prompt || negativePrompt;
          }

          if (last) {
            finals.push({ title: plan.title, prompt: last.prompt, score: last.critique?.score, missing: last.critique?.missing });
          }
        }

        if (req.signal.aborted) {
          status = "stopped";
        } else if (finals.length > 0) {
          send({ type: "status", message: "Suggesting options to try next…" });
          const options = await suggestOptions({ analysis, answers, results: finals });
          await updateRun(projectId, run.id, (r) => void (r.options = options));
          send({ type: "options", runId: run.id, options });
        }
      } catch (err) {
        status = req.signal.aborted ? "stopped" : "error";
        const message = describeApiError(err);
        if (status === "error") send({ type: "error", message });
        await updateRun(projectId, run.id, (r) => void (r.error = message)).catch(() => {});
      } finally {
        await updateRun(projectId, run.id, (r) => void (r.status = status)).catch(() => {});
        send({ type: "done", runId: run.id, status });
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
  });
}
