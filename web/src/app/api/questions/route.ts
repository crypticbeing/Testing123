import { z } from "zod";
import { describeApiError } from "@/lib/claude";
import { askQuestions } from "@/lib/pipeline";
import { getProject, NotFoundError, readReferenceImages, updateProject } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({ projectId: z.string() });

/** Stage 2: write questions about the analysed images and save them. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Missing projectId." }, { status: 400 });
  try {
    const project = await getProject(parsed.data.projectId);
    if (!project.analysis) return Response.json({ error: "Analyse the images first." }, { status: 409 });
    const questions = await askQuestions(await readReferenceImages(project), project.analysis);
    await updateProject(project.id, (p) => {
      p.questions = questions;
      p.answers = {};
    });
    return Response.json({ questions });
  } catch (err) {
    if (err instanceof NotFoundError) return Response.json({ error: "Project not found." }, { status: 404 });
    return Response.json({ error: describeApiError(err) }, { status: 502 });
  }
}
