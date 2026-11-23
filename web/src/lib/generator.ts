import "server-only";
import zlib from "node:zlib";

/**
 * Image generation backends.
 *  - "local": our own diffusion server (../generator/server.py) running on your GPU.
 *  - "mock":  draws a placeholder PNG so the whole flow works without a GPU.
 * Choose with IMAGE_BACKEND (default: local if GENERATOR_URL is set, otherwise mock).
 */

export interface GenerateParams {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  seed: number;
  initImage?: { mediaType: string; data: string };
  strength?: number;
}

export interface GeneratedImage {
  data: string; // base64 PNG
  mediaType: "image/png";
  seed: number;
  backend: string;
}

export function backendName(): "local" | "mock" {
  const b = process.env.IMAGE_BACKEND;
  if (b === "local" || b === "mock") return b;
  return process.env.GENERATOR_URL ? "local" : "mock";
}

export async function generateImage(p: GenerateParams): Promise<GeneratedImage> {
  return backendName() === "local" ? generateLocal(p) : generateMock(p);
}

// ---------------- local diffusion server ----------------
async function generateLocal(p: GenerateParams): Promise<GeneratedImage> {
  const url = (process.env.GENERATOR_URL ?? "http://127.0.0.1:8000").replace(/\/$/, "");
  let res: Response;
  try {
    res = await fetch(`${url}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: p.prompt,
        negative_prompt: p.negativePrompt,
        width: p.width,
        height: p.height,
        seed: p.seed,
        init_image: p.initImage?.data,
        strength: p.strength,
      }),
      signal: AbortSignal.timeout(10 * 60 * 1000),
    });
  } catch (err) {
    throw new Error(
      `Could not reach the image generator at ${url}. Start it with "python generator/server.py" or set IMAGE_BACKEND=mock. (${String(err)})`,
    );
  }
  if (!res.ok) throw new Error(`Image generator error ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { image: string; seed: number; model?: string };
  return { data: json.image, mediaType: "image/png", seed: json.seed, backend: json.model ?? "local" };
}

// ---------------- mock (no GPU) ----------------
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function generateMock(p: GenerateParams): Promise<GeneratedImage> {
  // Small placeholder: colours and shapes are derived from the prompt + seed.
  const w = 512;
  const h = Math.round((512 * p.height) / p.width);
  const seed = hash(p.prompt + p.seed);
  const c1 = hsl(seed % 360, 0.6, 0.55);
  const c2 = hsl((seed >>> 9) % 360, 0.65, 0.3);
  const cx = w * (0.3 + ((seed >>> 3) % 40) / 100);
  const cy = h * (0.3 + ((seed >>> 5) % 40) / 100);
  const r = Math.min(w, h) * 0.22;
  const px = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const t = (x / w + y / h) / 2;
      const inCircle = (x - cx) ** 2 + (y - cy) ** 2 < r * r;
      const i = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        const base = c1[c] * (1 - t) + c2[c] * t;
        px[i + c] = inCircle ? 255 - base * 0.5 : base;
      }
    }
  }
  await new Promise((r) => setTimeout(r, 300));
  return { data: encodePng(w, h, px).toString("base64"), mediaType: "image/png", seed: p.seed, backend: "mock" };
}
