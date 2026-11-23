import { z } from "zod";

/** An image sent from the browser (already resized, base64 without the data: prefix). */
export const InputImageSchema = z.object({
  mediaType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  data: z.string().min(1),
  name: z.string().optional(),
});
export type InputImage = z.infer<typeof InputImageSchema>;

// ---------- Stage 1: analysis ----------
export const AnalysisSchema = z.object({
  title: z.string().describe("A short 2-5 word name for this project, based on what the images show."),
  summary: z.string().describe("Two or three sentences describing what the images show as a set."),
  subjects: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        key_details: z
          .array(z.string())
          .describe("Small identifying details that must survive into the output (marks, accessories, textures, text, proportions)."),
      }),
    )
    .describe("Every important subject, person, object or element."),
  style: z.object({
    medium: z.string().describe("e.g. photograph, 3D render, oil painting, vector illustration"),
    art_style: z.string(),
    lighting: z.string(),
    color_palette: z.array(z.string()).describe("Dominant colours, as names or hex codes."),
    mood: z.string(),
    camera: z.string().describe("Framing, angle, lens feel, depth of field."),
  }),
  composition: z.string(),
  fine_details: z
    .array(z.string())
    .describe("Tiny details across the images that a generator would easily lose. Be exhaustive and concrete."),
  gaps: z
    .array(z.string())
    .describe("Things that are missing, ambiguous, cut off or flawed in the inputs and would need to be filled in or fixed."),
  per_image: z.array(z.object({ index: z.number().describe("0-based image index"), description: z.string() })),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

// ---------- Stage 2: questions ----------
export const QuestionsSchema = z.object({
  questions: z.array(
    z.object({
      id: z.string().describe("short snake_case id"),
      question: z.string(),
      why: z.string().describe("One short sentence: why the answer changes the output."),
      kind: z.enum(["choice", "text"]),
      options: z.array(z.string()).describe("Suggested answers for 'choice' questions; empty for 'text'."),
      default_answer: z.string().describe("What you would assume if the user skips the question."),
    }),
  ),
});
export type Question = z.infer<typeof QuestionsSchema>["questions"][number];

export const AnswerSchema = z.object({ question: z.string(), answer: z.string() });
export type Answer = z.infer<typeof AnswerSchema>;

// ---------- Stage 3: prompts, critique, options ----------
export const PromptPlansSchema = z.object({
  plans: z.array(
    z.object({
      title: z.string().describe("2-5 word name for this variation"),
      prompt: z.string(),
      negative_prompt: z.string(),
      checklist: z
        .array(z.string())
        .describe("Concrete, visually checkable requirements the image must satisfy, most important first."),
      rationale: z.string(),
    }),
  ),
});
export type PromptPlan = z.infer<typeof PromptPlansSchema>["plans"][number];

export const CritiqueSchema = z.object({
  score: z.number().describe("0-100: how well the image satisfies the checklist and the user's intent."),
  matched: z.array(z.string()).describe("Checklist items clearly present."),
  missing: z.array(z.string()).describe("Checklist items absent or wrong."),
  defects: z.array(z.string()).describe("Visual problems: anatomy, artefacts, wrong text, wrong colours, extra objects."),
  verdict: z.enum(["accept", "refine"]),
  revised_prompt: z.string().describe("Improved prompt that fixes what is missing. Repeat the previous prompt if accepted."),
  revised_negative_prompt: z.string(),
  notes: z.string().describe("One or two sentences explaining the change."),
});
export type Critique = z.infer<typeof CritiqueSchema>;

export const OptionsSchema = z.object({
  options: z.array(
    z.object({
      title: z.string().describe("2-5 words"),
      direction: z.string().describe("One sentence instruction describing the variation to try."),
    }),
  ),
});
export type TryOption = z.infer<typeof OptionsSchema>["options"][number];

// ---------- Project settings ----------
export const ASPECTS: Record<string, [number, number]> = {
  "Square 1:1": [1024, 1024],
  "Portrait 3:4": [896, 1152],
  "Landscape 4:3": [1152, 896],
  "Wide 16:9": [1344, 768],
  "Tall 9:16": [768, 1344],
};

export const ProjectSettingsSchema = z.object({
  count: z.number().int().min(1).max(4),
  maxRounds: z.number().int().min(1).max(5),
  targetScore: z.number().min(0).max(100),
  aspect: z.string().refine((a) => a in ASPECTS, "Unknown aspect"),
  useReference: z.boolean(),
  referenceStrength: z.number().min(0.05).max(0.95),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const DEFAULT_SETTINGS: ProjectSettings = {
  count: 2,
  maxRounds: 3,
  targetScore: 85,
  aspect: "Square 1:1",
  useReference: false,
  referenceStrength: 0.55,
};

// ---------- Generate request + streamed events ----------
export const GenerateRequestSchema = z.object({
  projectId: z.string(),
  answers: z.record(z.string(), z.string()),
  settings: ProjectSettingsSchema,
  direction: z.string().max(2000).optional(),
  basePrompt: z.string().max(4000).optional(),
});
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

export interface Generation {
  id: string;
  runId: string;
  variant: number;
  variantTitle: string;
  round: number;
  prompt: string;
  negativePrompt: string;
  seed: number;
  backend: string;
  image: string; // URL of the saved image
  checklist: string[];
  createdAt: string;
  critique?: Critique;
}

/** Run metadata as sent to the browser (the stored run minus its generations). */
export interface RunInfo {
  id: string;
  number: number;
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "done" | "stopped" | "error" | "interrupted";
  direction?: string;
  basePrompt?: string;
  settings: ProjectSettings;
  plans: PromptPlan[];
  options: TryOption[];
  error?: string;
}

export type GenerateEvent =
  | { type: "run"; run: RunInfo }
  | { type: "status"; message: string }
  | { type: "plans"; runId: string; plans: PromptPlan[] }
  | { type: "generation"; generation: Generation }
  | { type: "critique"; runId: string; id: string; critique: Critique }
  | { type: "options"; runId: string; options: TryOption[] }
  | { type: "error"; message: string }
  | { type: "done"; runId: string; status: RunInfo["status"] };
