# Detail Studio

A website that turns your reference images into new images while keeping the small details you care about.

1. **Analyse.** Upload up to 6 images. Claude studies them and lists subjects, style, lighting, palette, camera, the fine details a generator would easily lose, and anything missing or flawed.
2. **Questions.** Claude asks 4–7 questions about your images (what it's for, which details matter most, what to change). Skipped questions use a sensible default.
3. **Create.** For each variation, Claude writes a prompt, a negative prompt and a checklist. Our own diffusion server draws the image. Claude then compares the result with your references and the checklist, scores it, lists what's missing, rewrites the prompt and draws again. This repeats until the image passes or the round limit is reached.
4. **Output space.** Every image (every round of every variation) appears in a gallery with its own prompt, negative prompt, seed, score and checklist results. Select one to download it, copy its prompt, or refine it, and pick from the suggested **options to try**.
5. **Projects and history.** Everything is saved as you go. The home page lists your projects with their best-scoring image as the cover. Inside a project, each generation run is kept in the history (newest first) with its direction, time and status, so you can come back later, compare runs, reuse a prompt, or delete runs you don't need.

```
web/        Next.js + TypeScript website and API (Claude: analysis, questions, prompts, self-checks)
generator/  Self-hosted image generator (Python, Hugging Face diffusers, SDXL by default)
```

## Run it

### 1. The website

```bash
cd web
npm install
cp .env.example .env.local   # then put your ANTHROPIC_API_KEY in it
npm run dev                  # http://localhost:3000
```

With `IMAGE_BACKEND=mock` (the default in `.env.example`), the full flow works without a GPU: images are coloured placeholders. Use this to try the analysis, questions and gallery.

### 2. The image generator (needs a GPU)

```bash
cd generator
python -m venv .venv && source .venv/bin/activate
# Install PyTorch for your GPU from https://pytorch.org/get-started/locally/ first
pip install -r requirements.txt
python server.py             # first run downloads the model (~7 GB for SDXL)
```

Then set `IMAGE_BACKEND=local` in `web/.env.local` and restart the website. The badge in the top-right corner shows which generator is connected.

| Setting | Where | Default | Notes |
|---|---|---|---|
| `MODEL_ID` | generator | `stabilityai/stable-diffusion-xl-base-1.0` | Any diffusers text-to-image model. `stabilityai/sdxl-turbo` is much faster (set `STEPS=4 GUIDANCE=0`). |
| `STEPS`, `GUIDANCE` | generator | `30`, `6.5` | Quality vs speed. |
| `GENERATOR_URL` | web | `http://127.0.0.1:8000` | Where the generator runs. |
| `PROMPT_WORD_LIMIT` | web | `70` | SDXL reads about 75 tokens of prompt. Raise it for models with long text encoders such as FLUX. |
| `CLAUDE_MODEL` | web | `claude-opus-5-5` | Model used for every Claude step. |

SDXL needs roughly 10 GB of GPU memory. On a Mac with Apple silicon it runs on `mps`; on a CPU it works but is very slow.

## Where projects are saved

Projects are stored as plain files in `web/data/` (change it with `DATA_DIR`). This folder is not committed to git.

```
data/projects/<project-id>/
  project.json        name, analysis, questions, your answers, settings, selected image
  runs/<run-id>.json  one file per run: prompts, every image's prompt and self-check, options to try
  images/             your reference images and every generated image (PNG)
```

To back up or move your work, copy the `data` folder. Answers and settings save automatically while you type. A run that was still going when the server stopped shows as "interrupted".

Because projects live on the server's disk, run the site on your own machine or a server with a persistent disk. Serverless hosts such as Vercel wipe the disk, so projects would not survive there.

## Notes

- **Image-to-image.** Tick "Start from my first image" to begin from your first reference instead of from noise. "Change amount" controls how far the result may move from it.
- **Same seed for each round.** Refinement rounds keep the seed, so differences between rounds come from the corrected prompt.
- **Cost.** Each self-check sends your references plus the new image to Claude. Two variations with three rounds each means up to 6 checks, plus one call each for analysis, questions, prompts and options.
- **Refusal fallback.** Claude calls opt in to server-side refusal fallbacks (`fallbacks: "default"`), so a safety decline is retried on another model before an error is shown.
