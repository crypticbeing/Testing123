"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./studio.module.css";
import type {
  Analysis,
  Answer,
  GenerateEvent,
  Generation,
  InputImage,
  PromptPlan,
  Question,
  TryOption,
} from "@/lib/types";

type Stage = "upload" | "questions" | "create";

interface Status {
  claudeModel: string;
  claudeKey: boolean;
  backend: string;
  generator: { ok: boolean; model?: string; error?: string };
}

const ASPECTS: Record<string, [number, number]> = {
  "Square 1:1": [1024, 1024],
  "Portrait 3:4": [896, 1152],
  "Landscape 4:3": [1152, 896],
  "Wide 16:9": [1344, 768],
  "Tall 9:16": [768, 1344],
};

/** Resize an uploaded file in the browser so requests stay small (longest side ≤ 1280px, JPEG). */
async function fileToInputImage(file: File): Promise<InputImage & { preview: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error(`Could not read ${file.name}`));
      el.src = url;
    });
    const scale = Math.min(1, 1280 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.9);
    return { mediaType: "image/jpeg", data: dataUrl.split(",")[1], name: file.name, preview: dataUrl };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

export default function Studio() {
  const [status, setStatus] = useState<Status | null>(null);
  const [stage, setStage] = useState<Stage>("upload");
  const [images, setImages] = useState<(InputImage & { preview: string })[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // generation settings
  const [count, setCount] = useState(2);
  const [maxRounds, setMaxRounds] = useState(3);
  const [targetScore, setTargetScore] = useState(85);
  const [aspect, setAspect] = useState("Square 1:1");
  const [useReference, setUseReference] = useState(false);
  const [strength, setStrength] = useState(0.55);

  // results
  const [generations, setGenerations] = useState<Generation[]>([]);
  const [plans, setPlans] = useState<PromptPlan[]>([]);
  const [options, setOptions] = useState<TryOption[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [customDirection, setCustomDirection] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  const selected = useMemo(() => generations.find((g) => g.id === selectedId) ?? null, [generations, selectedId]);

  const answerList = useCallback(
    (): Answer[] =>
      questions.map((q) => ({ question: q.question, answer: answers[q.id]?.trim() || `(skipped – assume: ${q.default_answer})` })),
    [questions, answers],
  );

  // ---------------- stage 1 ----------------
  async function addFiles(files: FileList | File[]) {
    setError(null);
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const room = 6 - images.length;
    if (list.length > room) setError("You can use up to 6 reference images.");
    try {
      const converted = await Promise.all(list.slice(0, room).map(fileToInputImage));
      setImages((prev) => [...prev, ...converted]);
      setAnalysis(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const payloadImages = () => images.map(({ mediaType, data, name }) => ({ mediaType, data, name }));

  async function runAnalysis() {
    setError(null);
    try {
      setBusy("Stage 1 · Analysing every detail of your images…");
      const { analysis } = await postJson<{ analysis: Analysis }>("/api/analyze", { images: payloadImages() });
      setAnalysis(analysis);
      setBusy("Stage 2 · Preparing questions about your images…");
      const { questions } = await postJson<{ questions: Question[] }>("/api/questions", { images: payloadImages(), analysis });
      setQuestions(questions);
      setAnswers({});
      setStage("questions");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  // ---------------- stage 3 ----------------
  async function runGenerate(extra: { direction?: string; basePrompt?: string } = {}) {
    if (!analysis) return;
    setError(null);
    setStage("create");
    setOptions([]);
    setLog([]);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const [width, height] = ASPECTS[aspect];
    setBusy(extra.direction ? `Trying: ${extra.direction}` : "Stage 3 · Creating…");

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          images: payloadImages(),
          analysis,
          answers: answerList(),
          count,
          maxRounds,
          targetScore,
          useReference,
          referenceStrength: strength,
          width,
          height,
          ...extra,
        }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `Generate failed (${res.status})`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) handleEvent(JSON.parse(line) as GenerateEvent);
        }
      }
    } catch (e) {
      if ((e as Error).name !== "AbortError") setError((e as Error).message);
    } finally {
      if (abortRef.current === ctrl) {
        abortRef.current = null;
        setBusy(null);
      }
    }
  }

  function handleEvent(e: GenerateEvent) {
    switch (e.type) {
      case "status":
        setBusy(e.message);
        setLog((l) => [...l, e.message]);
        break;
      case "plans":
        setPlans(e.plans);
        break;
      case "generation":
        setGenerations((g) => [e.generation, ...g]);
        setSelectedId((cur) => cur ?? e.generation.id);
        break;
      case "critique":
        setGenerations((g) => g.map((x) => (x.id === e.id ? { ...x, critique: e.critique } : x)));
        setLog((l) => [...l, `Score ${Math.round(e.critique.score)} · ${e.critique.verdict === "accept" ? "accepted" : "refining"} – ${e.critique.notes}`]);
        break;
      case "options":
        setOptions(e.options);
        break;
      case "error":
        setError(e.message);
        break;
      case "done":
        setLog((l) => [...l, "Done."]);
        break;
    }
  }

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(null);
  }

  function tryOption(direction: string) {
    void runGenerate({ direction, basePrompt: selected?.prompt });
  }

  function startOver() {
    stop();
    setStage("upload");
    setImages([]);
    setAnalysis(null);
    setQuestions([]);
    setAnswers({});
    setGenerations([]);
    setPlans([]);
    setOptions([]);
    setSelectedId(null);
    setError(null);
  }

  // ---------------- render ----------------
  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.logo}>◆</span> Detail Studio
        </div>
        <nav className={styles.steps}>
          {(["upload", "questions", "create"] as Stage[]).map((s, i) => (
            <button
              key={s}
              className={`${styles.step} ${stage === s ? styles.stepActive : ""}`}
              disabled={(s === "questions" && !analysis) || (s === "create" && !analysis)}
              onClick={() => setStage(s)}
            >
              <span>{i + 1}</span> {s === "upload" ? "Analyse" : s === "questions" ? "Questions" : "Create"}
            </button>
          ))}
        </nav>
        <StatusPill status={status} />
      </header>

      {error && (
        <div className={styles.error} role="alert">
          {error}
          <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {busy && (
        <div className={styles.busy}>
          <span className={styles.spinner} /> {busy}
          {abortRef.current && <button className={styles.linkBtn} onClick={stop}>Stop</button>}
        </div>
      )}

      {stage === "upload" && (
        <section className={styles.panel}>
          <h2>1 · Upload your reference images</h2>
          <p className={styles.muted}>Add up to 6 images. They are analysed for subjects, style and every small detail worth keeping.</p>
          <label
            className={styles.drop}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void addFiles(e.dataTransfer.files);
            }}
          >
            <input type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && void addFiles(e.target.files)} />
            <strong>Drop images here</strong> or click to choose
          </label>
          {images.length > 0 && (
            <div className={styles.thumbs}>
              {images.map((img, i) => (
                <figure key={i} className={styles.thumb}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.preview} alt={img.name ?? `Reference ${i + 1}`} />
                  <button aria-label="Remove image" onClick={() => setImages((p) => p.filter((_, j) => j !== i))}>×</button>
                </figure>
              ))}
            </div>
          )}
          <div className={styles.actions}>
            <button className={styles.primary} disabled={images.length === 0 || !!busy} onClick={runAnalysis}>
              Analyse images
            </button>
            {images.length > 0 && <button className={styles.ghost} onClick={startOver}>Clear</button>}
          </div>
          {analysis && <AnalysisCard analysis={analysis} />}
        </section>
      )}

      {stage === "questions" && analysis && (
        <section className={styles.panel}>
          <h2>2 · A few questions about your images</h2>
          <p className={styles.muted}>Answer what matters to you. Skipped questions use the suggested default.</p>
          <details className={styles.analysisToggle}>
            <summary>Show stage 1 analysis</summary>
            <AnalysisCard analysis={analysis} />
          </details>
          <div className={styles.questions}>
            {questions.map((q) => (
              <div key={q.id} className={styles.question}>
                <div className={styles.qText}>{q.question}</div>
                <div className={styles.qWhy}>{q.why}</div>
                {q.kind === "choice" && q.options.length > 0 && (
                  <div className={styles.chips}>
                    {q.options.map((o) => (
                      <button
                        key={o}
                        className={`${styles.chip} ${answers[q.id] === o ? styles.chipOn : ""}`}
                        onClick={() => setAnswers((a) => ({ ...a, [q.id]: a[q.id] === o ? "" : o }))}
                      >
                        {o}
                      </button>
                    ))}
                  </div>
                )}
                <input
                  className={styles.input}
                  placeholder={`Your answer (default: ${q.default_answer})`}
                  value={answers[q.id] ?? ""}
                  onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
                />
              </div>
            ))}
          </div>

          <h3>Generation settings</h3>
          <div className={styles.settings}>
            <label>
              Variations
              <select value={count} onChange={(e) => setCount(Number(e.target.value))}>
                {[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}
              </select>
            </label>
            <label>
              Self-correction rounds
              <select value={maxRounds} onChange={(e) => setMaxRounds(Number(e.target.value))}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}
              </select>
            </label>
            <label>
              Accept at score
              <input type="number" min={50} max={100} value={targetScore} onChange={(e) => setTargetScore(Number(e.target.value))} />
            </label>
            <label>
              Aspect
              <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
                {Object.keys(ASPECTS).map((a) => <option key={a}>{a}</option>)}
              </select>
            </label>
            <label className={styles.check}>
              <input type="checkbox" checked={useReference} onChange={(e) => setUseReference(e.target.checked)} />
              Start from my first image (image-to-image)
            </label>
            {useReference && (
              <label>
                Change amount {strength.toFixed(2)}
                <input type="range" min={0.1} max={0.9} step={0.05} value={strength} onChange={(e) => setStrength(Number(e.target.value))} />
              </label>
            )}
          </div>
          <div className={styles.actions}>
            <button className={styles.primary} disabled={!!busy} onClick={() => void runGenerate()}>
              Generate
            </button>
            <button className={styles.ghost} onClick={() => setStage("upload")}>Back</button>
          </div>
        </section>
      )}

      {stage === "create" && (
        <section className={styles.create}>
          <div className={styles.galleryCol}>
            <h2>3 · Output space</h2>
            {plans.length > 0 && (
              <div className={styles.plans}>
                {plans.map((p, i) => (
                  <span key={i} className={styles.planTag} title={p.rationale}>{p.title}</span>
                ))}
              </div>
            )}
            {generations.length === 0 && <p className={styles.muted}>Images appear here as they are generated and checked.</p>}
            <div className={styles.gallery}>
              {generations.map((g) => (
                <button
                  key={g.id}
                  className={`${styles.card} ${g.id === selectedId ? styles.cardOn : ""}`}
                  onClick={() => setSelectedId(g.id)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={g.image} alt={g.prompt} />
                  <div className={styles.cardMeta}>
                    <span>{g.variantTitle} · round {g.round}</span>
                    <ScoreBadge g={g} />
                  </div>
                </button>
              ))}
            </div>
            {log.length > 0 && (
              <details className={styles.log}>
                <summary>Activity log ({log.length})</summary>
                <ol>{log.map((l, i) => <li key={i}>{l}</li>)}</ol>
              </details>
            )}
          </div>

          <aside className={styles.side}>
            {selected ? (
              <SelectedPanel g={selected} />
            ) : (
              <p className={styles.muted}>Select an image to see its prompt and review.</p>
            )}

            <div className={styles.optionsBox}>
              <h3>Options to try</h3>
              {options.length === 0 && <p className={styles.muted}>Suggestions appear after a run finishes.</p>}
              <div className={styles.optionList}>
                {options.map((o) => (
                  <button key={o.title} className={styles.option} disabled={!!busy} onClick={() => tryOption(o.direction)}>
                    <strong>{o.title}</strong>
                    <span>{o.direction}</span>
                  </button>
                ))}
              </div>
              <form
                className={styles.custom}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (customDirection.trim()) tryOption(customDirection.trim());
                }}
              >
                <input
                  className={styles.input}
                  placeholder={selected ? "Refine the selected image: e.g. warmer light, add the red scarf" : "Describe a change to try"}
                  value={customDirection}
                  onChange={(e) => setCustomDirection(e.target.value)}
                />
                <button className={styles.primary} disabled={!!busy || !customDirection.trim()}>Try</button>
              </form>
              <div className={styles.actions}>
                <button className={styles.ghost} disabled={!!busy} onClick={() => void runGenerate()}>Generate again</button>
                <button className={styles.ghost} onClick={() => setStage("questions")}>Edit answers</button>
                <button className={styles.ghost} onClick={startOver}>New project</button>
              </div>
            </div>
          </aside>
        </section>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: Status | null }) {
  if (!status) return <div className={styles.pill}>checking…</div>;
  const problems = [!status.claudeKey && "no Claude API key", !status.generator.ok && `generator ${status.generator.error}`].filter(Boolean);
  return (
    <div className={`${styles.pill} ${problems.length ? styles.pillWarn : ""}`} title={problems.join(", ")}>
      {status.backend === "mock" ? "mock images" : status.generator.model ?? "local generator"}
      {problems.length > 0 && ` · ${problems.join(", ")}`}
    </div>
  );
}

function ScoreBadge({ g }: { g: Generation }) {
  if (!g.critique) return <span className={styles.badge}>checking…</span>;
  const s = Math.round(g.critique.score);
  return <span className={`${styles.badge} ${s >= 85 ? styles.good : s >= 60 ? styles.ok : styles.bad}`}>{s}</span>;
}

function SelectedPanel({ g }: { g: Generation }) {
  const [copied, setCopied] = useState(false);
  const c = g.critique;
  return (
    <div className={styles.selected}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={g.image} alt={g.prompt} />
      <div className={styles.row}>
        <a className={styles.ghost} href={g.image} download={`${g.variantTitle.replace(/\W+/g, "-")}-r${g.round}.png`}>Download</a>
        <button
          className={styles.ghost}
          onClick={() => {
            void navigator.clipboard.writeText(g.prompt);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "Copied" : "Copy prompt"}
        </button>
      </div>
      <dl className={styles.meta}>
        <dt>Prompt</dt>
        <dd className={styles.prompt}>{g.prompt}</dd>
        <dt>Negative prompt</dt>
        <dd className={styles.promptNeg}>{g.negativePrompt}</dd>
        <dt>Seed · model</dt>
        <dd>{g.seed} · {g.backend}</dd>
      </dl>
      {c && (
        <div className={styles.review}>
          <h4>Self-check · score {Math.round(c.score)} · {c.verdict === "accept" ? "accepted" : "refined in next round"}</h4>
          <p>{c.notes}</p>
          {c.matched.length > 0 && <ul className={styles.matched}>{c.matched.map((m) => <li key={m}>✓ {m}</li>)}</ul>}
          {c.missing.length > 0 && <ul className={styles.missing}>{c.missing.map((m) => <li key={m}>✗ {m}</li>)}</ul>}
          {c.defects.length > 0 && <ul className={styles.missing}>{c.defects.map((m) => <li key={m}>⚠ {m}</li>)}</ul>}
        </div>
      )}
    </div>
  );
}

function AnalysisCard({ analysis }: { analysis: Analysis }) {
  return (
    <div className={styles.analysis}>
      <h3>What I see</h3>
      <p>{analysis.summary}</p>
      <div className={styles.analysisGrid}>
        <div>
          <h4>Subjects</h4>
          <ul>{analysis.subjects.map((s) => <li key={s.name}><strong>{s.name}</strong>: {s.description}</li>)}</ul>
        </div>
        <div>
          <h4>Style</h4>
          <ul>
            <li>{analysis.style.medium}, {analysis.style.art_style}</li>
            <li>Lighting: {analysis.style.lighting}</li>
            <li>Mood: {analysis.style.mood}</li>
            <li>Camera: {analysis.style.camera}</li>
            <li>Palette: {analysis.style.color_palette.join(", ")}</li>
          </ul>
        </div>
        <div>
          <h4>Fine details to keep</h4>
          <ul>{analysis.fine_details.map((d) => <li key={d}>{d}</li>)}</ul>
        </div>
        <div>
          <h4>Missing or to fix</h4>
          <ul>{analysis.gaps.map((d) => <li key={d}>{d}</li>)}</ul>
        </div>
      </div>
    </div>
  );
}
