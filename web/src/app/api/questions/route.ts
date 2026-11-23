import { z } from "zod";
import { describeApiError } from "@/lib/claude";
import { askQuestions } from "@/lib/pipeline";
import { AnalysisSchema, InputImageSchema } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({ images: z.array(InputImageSchema).min(1).max(6), analysis: AnalysisSchema });

/** Stage 2: ask the user questions about the analysed images. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Missing images or analysis." }, { status: 400 });
  try {
    const questions = await askQuestions(parsed.data.images, parsed.data.analysis);
    return Response.json({ questions });
  } catch (err) {
    return Response.json({ error: describeApiError(err) }, { status: 502 });
  }
}
