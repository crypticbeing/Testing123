import { MODEL } from "@/lib/claude";
import { backendName } from "@/lib/generator";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const backend = backendName();
  let generator: { ok: boolean; model?: string; error?: string } = { ok: true, model: "mock" };
  if (backend === "local") {
    const url = (process.env.GENERATOR_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
      generator = res.ok ? { ok: true, ...(await res.json()) } : { ok: false, error: `HTTP ${res.status}` };
    } catch {
      generator = { ok: false, error: `not reachable at ${url}` };
    }
  }
  return Response.json({
    claudeModel: MODEL,
    claudeKey: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN),
    backend,
    generator,
  });
}
