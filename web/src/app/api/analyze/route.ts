import { z } from "zod";
import { describeApiError } from "@/lib/claude";
import { analyzeImages } from "@/lib/pipeline";
import { InputImageSchema } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({ images: z.array(InputImageSchema).min(1).max(6) });

/** Stage 1: analyse the uploaded reference images. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Upload between 1 and 6 images." }, { status: 400 });
  try {
    const analysis = await analyzeImages(parsed.data.images);
    return Response.json({ analysis });
  } catch (err) {
    return Response.json({ error: describeApiError(err) }, { status: 502 });
  }
}
