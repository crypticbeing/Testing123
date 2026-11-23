import "server-only";
import { askStructured, imageBlock, textBlock } from "./claude";
import {
  AnalysisSchema,
  CritiqueSchema,
  OptionsSchema,
  PromptPlansSchema,
  QuestionsSchema,
  type Analysis,
  type Answer,
  type Critique,
  type InputImage,
  type PromptPlan,
  type Question,
  type TryOption,
} from "./types";

const PROMPT_WORD_LIMIT = Number(process.env.PROMPT_WORD_LIMIT ?? 70);

function refImages(images: InputImage[]) {
  return images.flatMap((img, i) => [textBlock(`Reference image ${i} (${img.name ?? "untitled"}):`), imageBlock(img)]);
}

function answersText(answers: Answer[]): string {
  if (answers.length === 0) return "(no answers given; use sensible defaults)";
  return answers.map((a) => `- Q: ${a.question}\n  A: ${a.answer}`).join("\n");
}

// ---------------- Stage 1 ----------------
export async function analyzeImages(images: InputImage[]): Promise<Analysis> {
  return askStructured({
    schema: AnalysisSchema,
    effort: "high",
    system: `You are the analysis stage of an image-generation studio.
The user uploads reference images and wants new images that keep every small detail of them.
Study the images closely, as a forensic art director would. Record subjects, style, lighting, palette, camera and composition,
and list fine details a diffusion model is likely to drop: logos, patterns, text, jewellery, scars, stitching, reflections, hand poses, proportions.
Also note what is missing, cut off, low quality or contradictory between images, so later stages can fill it in.
Write concrete visual descriptions, not opinions.`,
    content: [...refImages(images), textBlock("Analyse these reference images.")],
  });
}

// ---------------- Stage 2 ----------------
export async function askQuestions(images: InputImage[], analysis: Analysis): Promise<Question[]> {
  const res = await askStructured({
    schema: QuestionsSchema,
    effort: "medium",
    system: `You are the interview stage of an image-generation studio.
From the analysis and the reference images, ask the user 4 to 7 short questions whose answers would most change the final image:
goal and use of the image, which subject or details matter most, style to keep or change, framing and aspect, background, what to fix from the "gaps" list.
Prefer "choice" questions with 3-5 concrete options taken from what you see. Never ask something the images already answer.`,
    content: [
      ...refImages(images),
      textBlock(`Analysis of the images:\n${JSON.stringify(analysis, null, 2)}\n\nWrite the questions.`),
    ],
  });
  return res.questions;
}

// ---------------- Stage 3: prompt writing ----------------
export async function planPrompts(opts: {
  images: InputImage[];
  analysis: Analysis;
  answers: Answer[];
  count: number;
  direction?: string;
  basePrompt?: string;
}): Promise<PromptPlan[]> {
  const res = await askStructured({
    schema: PromptPlansSchema,
    effort: "high",
    system: `You write prompts for a self-hosted text-to-image diffusion model (Stable Diffusion XL family by default).
Rules for each prompt:
- At most ${PROMPT_WORD_LIMIT} words. Put the subject and the most important small details first: the text encoder truncates long prompts.
- Comma-separated descriptive phrases; concrete nouns, materials, colours, lighting, camera and style terms.
- Carry over the fine details from the analysis that the user cares about, and fix the listed gaps.
- The negative prompt lists what to avoid (artefacts, wrong styles, extra limbs, text errors, things the user rejected).
- The checklist holds 5-10 visually checkable requirements taken from the analysis and the answers; a reviewer will compare the image to it.
Write exactly ${opts.count} plans. Each plan is a meaningfully different take that still satisfies the user's answers.`,
    content: [
      ...refImages(opts.images),
      textBlock(
        [
          `Analysis:\n${JSON.stringify(opts.analysis, null, 2)}`,
          `User's answers:\n${answersText(opts.answers)}`,
          opts.basePrompt ? `Start from this earlier prompt the user selected:\n${opts.basePrompt}` : "",
          opts.direction ? `The user now wants this direction: ${opts.direction}` : "",
          `Write ${opts.count} prompt plans.`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
    ],
  });
  return res.plans.slice(0, opts.count);
}

// ---------------- Stage 3: self-rectification ----------------
export async function critique(opts: {
  images: InputImage[];
  analysis: Analysis;
  answers: Answer[];
  plan: { prompt: string; negativePrompt: string; checklist: string[] };
  generated: { mediaType: "image/png"; data: string };
  round: number;
  maxRounds: number;
}): Promise<Critique> {
  return askStructured({
    schema: CritiqueSchema,
    effort: "medium",
    system: `You are the quality-control stage of an image-generation studio.
Compare the GENERATED image with the reference images, the checklist and the user's answers.
Be strict about small details: count items, check colours, patterns, text, accessories and proportions.
Put each checklist item in "matched" or "missing", list visual defects, and score 0-100.
If anything important is missing or wrong, set verdict "refine" and rewrite the prompt so the next attempt fixes it:
move missing details earlier, describe them more concretely, add the defects to the negative prompt. Keep what already works.
Keep the revised prompt at most ${PROMPT_WORD_LIMIT} words.`,
    content: [
      ...refImages(opts.images),
      textBlock("GENERATED image:"),
      imageBlock(opts.generated),
      textBlock(
        [
          `Round ${opts.round} of at most ${opts.maxRounds}.`,
          `Prompt used:\n${opts.plan.prompt}`,
          `Negative prompt used:\n${opts.plan.negativePrompt}`,
          `Checklist:\n${opts.plan.checklist.map((c) => `- ${c}`).join("\n")}`,
          `User's answers:\n${answersText(opts.answers)}`,
          `Fine details from the analysis:\n${opts.analysis.fine_details.map((d) => `- ${d}`).join("\n")}`,
        ].join("\n\n"),
      ),
    ],
  });
}

// ---------------- Options to try ----------------
export async function suggestOptions(opts: {
  analysis: Analysis;
  answers: Answer[];
  results: { title: string; prompt: string; score?: number; missing?: string[] }[];
}): Promise<TryOption[]> {
  const res = await askStructured({
    schema: OptionsSchema,
    effort: "low",
    system: `You suggest next experiments in an image-generation studio.
Given the user's intent and the latest results, propose 4-6 varied, specific directions the user could try next:
style shifts, lighting, framing, background, mood, or ways to recover details that were still missing.`,
    content: [
      textBlock(
        [
          `Summary of the references: ${opts.analysis.summary}`,
          `User's answers:\n${answersText(opts.answers)}`,
          `Latest results:\n${JSON.stringify(opts.results, null, 2)}`,
        ].join("\n\n"),
      ),
    ],
  });
  return res.options;
}
