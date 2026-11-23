import { z } from "zod";
import { deleteProject, getProject, listRuns, NotFoundError, updateProject } from "@/lib/store";
import { ProjectSettingsSchema } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

function notFound(err: unknown) {
  if (err instanceof NotFoundError) return Response.json({ error: "Project not found." }, { status: 404 });
  throw err;
}

/** A project with its full history of runs (newest first). */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    const [project, runs] = await Promise.all([getProject(id), listRuns(id)]);
    return Response.json({ project, runs });
  } catch (err) {
    return notFound(err);
  }
}

const Patch = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  answers: z.record(z.string(), z.string().max(2000)).optional(),
  settings: ProjectSettingsSchema.optional(),
  selectedId: z.string().nullable().optional(),
});

/** Autosave: name, answers, settings and the selected image. */
export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params;
  const parsed = Patch.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid update." }, { status: 400 });
  try {
    const project = await updateProject(id, (p) => {
      const d = parsed.data;
      if (d.name !== undefined) p.name = d.name;
      if (d.answers !== undefined) p.answers = d.answers;
      if (d.settings !== undefined) p.settings = d.settings;
      if (d.selectedId !== undefined) p.selectedId = d.selectedId;
    });
    return Response.json({ project });
  } catch (err) {
    return notFound(err);
  }
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  try {
    await getProject(id);
    await deleteProject(id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return notFound(err);
  }
}
