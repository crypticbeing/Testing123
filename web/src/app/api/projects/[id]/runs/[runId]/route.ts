import { deleteRun, NotFoundError } from "@/lib/store";

export const runtime = "nodejs";

/** Remove one run and its images from the project's history. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  try {
    await deleteRun(id, runId);
    return new Response(null, { status: 204 });
  } catch (err) {
    if (err instanceof NotFoundError) return Response.json({ error: "Run not found." }, { status: 404 });
    return Response.json({ error: (err as Error).message }, { status: 409 });
  }
}
