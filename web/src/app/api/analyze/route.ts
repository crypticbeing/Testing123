import { z } from "zod";
import { describeApiError } from "@/lib/claude";
import { analyzeImages } from "@/lib/pipeline";
import { getProject, NotFoundError, readReferenceImages, updateProject } from "@/lib/store";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({ projectId: z.string() });

/** Stage 1: analyse the project's reference images and save the result. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Missing projectId." }, { status: 400 });
  try {
    const project = await getProject(parsed.data.projectId);
    const analysis = await analyzeImages(await readReferenceImages(project));
    const saved = await updateProject(project.id, (p) => {
      p.analysis = analysis;
      if (p.name === "Untitled project" && analysis.title.trim()) p.name = analysis.title.trim().slice(0, 120);
    });
    return Response.json({ analysis, name: saved.name });
  } catch (err) {
    if (err instanceof NotFoundError) return Response.json({ error: "Project not found." }, { status: 404 });
    return Response.json({ error: describeApiError(err) }, { status: 502 });
  }
}
