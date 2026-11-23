import fs from "node:fs/promises";
import { imageFilePath, NotFoundError } from "@/lib/store";

export const runtime = "nodejs";

const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** Serve a saved reference or generated image. Files never change once written, so they cache forever. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; file: string }> }) {
  const { id, file } = await params;
  try {
    const data = await fs.readFile(imageFilePath(id, file));
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": TYPES[file.split(".").pop()!] ?? "application/octet-stream",
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    if (err instanceof NotFoundError || (err as NodeJS.ErrnoException).code === "ENOENT") {
      return new Response("Not found", { status: 404 });
    }
    throw err;
  }
}
