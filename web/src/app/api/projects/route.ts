import { z } from "zod";
import { createProject, listProjects } from "@/lib/store";
import { InputImageSchema } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List saved projects, most recently updated first. */
export async function GET() {
  return Response.json({ projects: await listProjects() });
}

const Body = z.object({ images: z.array(InputImageSchema).min(1).max(6), name: z.string().max(120).optional() });

/** Create a project from uploaded reference images. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Upload between 1 and 6 images." }, { status: 400 });
  const project = await createProject(parsed.data.images, parsed.data.name);
  return Response.json({ project }, { status: 201 });
}
