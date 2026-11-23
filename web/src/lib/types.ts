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

// ---------- Generate request + streamed events ----------
export const GenerateRequestSchema = z.object({
  images: z.array(InputImageSchema).min(1).max(6),
  analysis: AnalysisSchema,
  answers: z.array(AnswerSchema),
  direction: z.string().optional(),
  basePrompt: z.string().optional(),
  count: z.number().int().min(1).max(4).default(2),
  maxRounds: z.number().int().min(1).max(5).default(3),
  targetScore: z.number().min(0).max(100).default(85),
  useReference: z.boolean().default(false),
  referenceStrength: z.number().min(0.05).max(0.95).default(0.55),
  width: z.number().int().min(256).max(1536).default(1024),
  height: z.number().int().min(256).max(1536).default(1024),
});
export type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

export interface Generation {
  id: string;
  variant: number;
  variantTitle: string;
  round: number;
  prompt: string;
  negativePrompt: string;
  seed: number;
  backend: string;
  image: string; // data URL
  checklist: string[];
  critique?: Critique;
}

export type GenerateEvent =
  | { type: "status"; message: string }
  | { type: "plans"; plans: PromptPlan[] }
  | { type: "generation"; generation: Generation }
  | { type: "critique"; id: string; critique: Critique }
  | { type: "options"; options: TryOption[] }
  | { type: "error"; message: string }
  | { type: "done" };
