import { describeApiError } from "@/lib/claude";
import { generateImage } from "@/lib/generator";
import { critique, planPrompts, suggestOptions } from "@/lib/pipeline";
import { GenerateRequestSchema, type GenerateEvent, type Generation } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 800;

/**
 * Stage 3: write prompts, generate, self-check against the references, rewrite the prompt and regenerate
 * until the image passes or the round limit is reached. Progress streams back as NDJSON events.
 */
export async function POST(req: Request) {
  const parsed = GenerateRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid generate request.", details: parsed.error.issues }, { status: 400 });
  }
  const input = parsed.data;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: GenerateEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      const finals: { title: string; prompt: string; score?: number; missing?: string[] }[] = [];

      try {
        send({ type: "status", message: "Writing prompts from your images and answers…" });
        const plans = await planPrompts({
          images: input.images,
          analysis: input.analysis,
          answers: input.answers,
          count: input.count,
          direction: input.direction,
          basePrompt: input.basePrompt,
        });
        send({ type: "plans", plans });

        for (const [variant, plan] of plans.entries()) {
          if (req.signal.aborted) break;
          const seed = Math.floor(Math.random() * 2 ** 31);
          let prompt = plan.prompt;
          let negativePrompt = plan.negative_prompt;
          let last: Generation | undefined;

          for (let round = 1; round <= input.maxRounds; round++) {
            if (req.signal.aborted) break;
            send({ type: "status", message: `“${plan.title}”: generating round ${round}…` });
            const img = await generateImage({
              prompt,
              negativePrompt,
              width: input.width,
              height: input.height,
              seed, // same seed each round, so changes come from the corrected prompt
              initImage: input.useReference ? input.images[0] : undefined,
              strength: input.useReference ? input.referenceStrength : undefined,
            });

            const generation: Generation = {
              id: `v${variant}-r${round}-${seed}`,
              variant,
              variantTitle: plan.title,
              round,
              prompt,
              negativePrompt,
              seed: img.seed,
              backend: img.backend,
              image: `data:${img.mediaType};base64,${img.data}`,
              checklist: plan.checklist,
            };
            send({ type: "generation", generation });
            last = generation;

            send({ type: "status", message: `“${plan.title}”: checking round ${round} against your references…` });
            const review = await critique({
              images: input.images,
              analysis: input.analysis,
              answers: input.answers,
              plan: { prompt, negativePrompt, checklist: plan.checklist },
              generated: { mediaType: img.mediaType, data: img.data },
              round,
              maxRounds: input.maxRounds,
            });
            generation.critique = review;
            send({ type: "critique", id: generation.id, critique: review });

            if (review.verdict === "accept" || review.score >= input.targetScore) break;
            prompt = review.revised_prompt || prompt;
            negativePrompt = review.revised_negative_prompt || negativePrompt;
          }

          if (last) {
            finals.push({
              title: plan.title,
              prompt: last.prompt,
              score: last.critique?.score,
              missing: last.critique?.missing,
            });
          }
        }

        if (finals.length > 0 && !req.signal.aborted) {
          send({ type: "status", message: "Suggesting options to try next…" });
          const options = await suggestOptions({ analysis: input.analysis, answers: input.answers, results: finals });
          send({ type: "options", options });
        }
        send({ type: "done" });
      } catch (err) {
        send({ type: "error", message: describeApiError(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
  });
}
