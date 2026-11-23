"""
Detail Studio image generator: a self-hosted diffusion server.

Runs an open-source text-to-image model (Stable Diffusion XL by default) on your own GPU
and exposes two endpoints the web app calls:

  GET  /health    -> {"ok": true, "model": "...", "device": "..."}
  POST /generate  -> {"image": "<base64 PNG>", "seed": 123, "model": "..."}

Configuration (environment variables):
  MODEL_ID        Hugging Face model id (default: stabilityai/stable-diffusion-xl-base-1.0)
  STEPS           inference steps (default: 30; use 1-4 for sdxl-turbo)
  GUIDANCE        classifier-free guidance scale (default: 6.5; use 0.0 for sdxl-turbo)
  HOST / PORT     bind address (default: 127.0.0.1:8000)

Run:  python generator/server.py
"""

from __future__ import annotations

import base64
import io
import os
import threading

import torch
import uvicorn
from diffusers import AutoPipelineForImage2Image, AutoPipelineForText2Image
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel, Field

MODEL_ID = os.environ.get("MODEL_ID", "stabilityai/stable-diffusion-xl-base-1.0")
STEPS = int(os.environ.get("STEPS", "30"))
GUIDANCE = float(os.environ.get("GUIDANCE", "6.5"))

if torch.cuda.is_available():
    DEVICE, DTYPE = "cuda", torch.float16
elif torch.backends.mps.is_available():
    DEVICE, DTYPE = "mps", torch.float16
else:
    DEVICE, DTYPE = "cpu", torch.float32  # works, but very slow

print(f"Loading {MODEL_ID} on {DEVICE} ...", flush=True)
_kwargs = {"torch_dtype": DTYPE}
if DTYPE == torch.float16:
    _kwargs["variant"] = "fp16"
try:
    text2img = AutoPipelineForText2Image.from_pretrained(MODEL_ID, use_safetensors=True, **_kwargs)
except (OSError, ValueError):
    # Some repos don't publish an fp16 variant.
    _kwargs.pop("variant", None)
    text2img = AutoPipelineForText2Image.from_pretrained(MODEL_ID, use_safetensors=True, **_kwargs)
text2img = text2img.to(DEVICE)
if DEVICE == "cuda":
    text2img.enable_vae_slicing()
img2img = AutoPipelineForImage2Image.from_pipe(text2img)  # shares weights, no extra memory
print("Model ready.", flush=True)

# One GPU, one job at a time.
_lock = threading.Lock()

app = FastAPI(title="Detail Studio generator")


class GenerateRequest(BaseModel):
    prompt: str
    negative_prompt: str = ""
    width: int = Field(1024, ge=256, le=1536)
    height: int = Field(1024, ge=256, le=1536)
    seed: int | None = None
    steps: int | None = None
    guidance: float | None = None
    init_image: str | None = Field(None, description="base64 image for image-to-image")
    strength: float = Field(0.55, ge=0.05, le=0.95)


def _round8(v: int) -> int:
    return max(256, (v // 8) * 8)


@app.get("/health")
def health():
    return {"ok": True, "model": MODEL_ID, "device": DEVICE}


@app.post("/generate")
def generate(req: GenerateRequest):
    seed = req.seed if req.seed is not None else int(torch.randint(0, 2**31 - 1, (1,)).item())
    width, height = _round8(req.width), _round8(req.height)
    common = dict(
        prompt=req.prompt,
        negative_prompt=req.negative_prompt or None,
        num_inference_steps=req.steps or STEPS,
        guidance_scale=req.guidance if req.guidance is not None else GUIDANCE,
        generator=torch.Generator(device="cpu").manual_seed(seed),
    )

    try:
        with _lock, torch.inference_mode():
            if req.init_image:
                init = Image.open(io.BytesIO(base64.b64decode(req.init_image))).convert("RGB")
                init = init.resize((width, height), Image.LANCZOS)
                image = img2img(image=init, strength=req.strength, **common).images[0]
            else:
                image = text2img(width=width, height=height, **common).images[0]
    except torch.cuda.OutOfMemoryError as exc:
        torch.cuda.empty_cache()
        raise HTTPException(507, "GPU out of memory: try a smaller size or a lighter MODEL_ID") from exc

    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return {"image": base64.b64encode(buf.getvalue()).decode(), "seed": seed, "model": MODEL_ID}


if __name__ == "__main__":
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8000")))
