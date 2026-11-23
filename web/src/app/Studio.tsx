"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@/lib/store";
import styles from "./studio.module.css";
import {
  ASPECTS,
  DEFAULT_SETTINGS,
  type Analysis,
  type GenerateEvent,
  type Generation,
  type InputImage,
  type ProjectSettings,
  type Question,
  type RunInfo,
} from "@/lib/types";

type Stage = "upload" | "questions" | "create";
type RunView = RunInfo & { generations: Generation[] };
type RefImage = Partial<InputImage> & { preview: string };

interface Status {
  claudeModel: string;
  claudeKey: boolean;
  backend: string;
  generator: { ok: boolean; model?: string; error?: string };
}

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

async function api<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`);
  return json as T;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export default function Studio({ projectId: initialProjectId }: { projectId?: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [projectId, setProjectId] = useState<string | null>(initialProjectId ?? null);
  const [name, setName] = useState("New project");
  const [loading, setLoading] = useState(Boolean(initialProjectId));
  const [stage, setStage] = useState<Stage>("upload");
  const [images, setImages] = useState<RefImage[]>([]);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<ProjectSettings>(DEFAULT_SETTINGS);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [runs, setRuns] = useState<RunView[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [customDirection, setCustomDirection] = useState("");
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const loadedRef = useRef(!initialProjectId); // don't autosave before the project is loaded

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  // ---------- load a saved project ----------
  useEffect(() => {
    if (!initialProjectId) return;
    api<{ project: Project; runs: RunView[] }>(`/api/projects/${initialProjectId}`, "GET")
      .then(({ project, runs }) => {
        setName(project.name);
        setImages(project.references.map((r) => ({ preview: `/api/projects/${project.id}/images/${r.file}`, name: r.name })));
        setAnalysis(project.analysis);
        setQuestions(project.questions);
        setAnswers(project.answers);
        setSettings({ ...DEFAULT_SETTINGS, ...project.settings });
        setRuns(runs);
        setSelectedId(project.selectedId ?? runs[0]?.generations.at(-1)?.id ?? null);
        setStage(runs.length > 0 ? "create" : project.analysis ? "questions" : "upload");
        loadedRef.current = true;
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false));
  }, [initialProjectId]);

  // ---------- autosave answers, settings and selection ----------
  useEffect(() => {
    if (!projectId || !loadedRef.current) return;
    const t = setTimeout(() => {
      void api(`/api/projects/${projectId}`, "PATCH", { answers, settings, selectedId }).catch(() => {});
    }, 600);
    return () => clearTimeout(t);
  }, [projectId, answers, settings, selectedId]);

  const allGenerations = useMemo(() => runs.flatMap((r) => r.generations), [runs]);
  const selected = useMemo(() => allGenerations.find((g) => g.id === selectedId) ?? null, [allGenerations, selectedId]);
  const optionsRun = useMemo(
    () => (selected ? runs.find((r) => r.id === selected.runId) : undefined) ?? runs.find((r) => r.options.length > 0),
    [runs, selected],
  );

  const set = <K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  // ---------------- stage 1 ----------------
  async function addFiles(files: FileList | File[]) {
    setError(null);
    const list = Array.from(files).filter((f) => f.type.startsWith("image/"));
    const room = 6 - images.length;
    if (list.length > room) setError("You can use up to 6 reference images.");
    try {
      const converted = await Promise.all(list.slice(0, room).map(fileToInputImage));
      setImages((prev) => [...prev, ...converted]);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function runAnalysis() {
    setError(null);
    try {
      let id = projectId;
      if (!id) {
        setBusy("Saving your project…");
        const payload = images.map(({ mediaType, data, name }) => ({ mediaType, data, name }));
        const { project } = await api<{ project: { id: string; name: string } }>("/api/projects", "POST", { images: payload });
        id = project.id;
        setProjectId(id);
        loadedRef.current = true;
        // Update the URL without remounting, so a refresh reopens this project.
        window.history.replaceState(null, "", `/p/${id}`);
      }
      setBusy("Stage 1 · Analysing every detail of your images…");
      const res = await api<{ analysis: Analysis; name: string }>("/api/analyze", "POST", { projectId: id });
      setAnalysis(res.analysis);
      setName(res.name);
      setBusy("Stage 2 · Preparing questions about your images…");
      const { questions } = await api<{ questions: Question[] }>("/api/questions", "POST", { projectId: id });
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
    if (!analysis || !projectId) return;
    setError(null);
    setStage("create");
    setLog([]);
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setRunning(true);
    setBusy(extra.direction ? `Trying: ${extra.direction}` : "Stage 3 · Creating…");

    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({ projectId, answers, settings, ...extra }),
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
        setRunning(false);
        setBusy(null);
      }
    }
  }

  const patchRun = (id: string, fn: (r: RunView) => RunView) => setRuns((rs) => rs.map((r) => (r.id === id ? fn(r) : r)));

  function handleEvent(e: GenerateEvent) {
    switch (e.type) {
      case "run":
        setRuns((rs) => [{ ...e.run, generations: [] }, ...rs]);
        break;
      case "status":
        setBusy(e.message);
        setLog((l) => [...l, e.message]);
        break;
      case "plans":
        patchRun(e.runId, (r) => ({ ...r, plans: e.plans }));
        break;
      case "generation":
        patchRun(e.generation.runId, (r) => ({ ...r, generations: [...r.generations, e.generation] }));
        setSelectedId(e.generation.id);
        break;
      case "critique":
        patchRun(e.runId, (r) => ({
          ...r,
          generations: r.generations.map((g) => (g.id === e.id ? { ...g, critique: e.critique } : g)),
        }));
        setLog((l) => [
          ...l,
          `Score ${Math.round(e.critique.score)} · ${e.critique.verdict === "accept" ? "accepted" : "refining"}: ${e.critique.notes}`,
        ]);
        break;
      case "options":
        patchRun(e.runId, (r) => ({ ...r, options: e.options }));
        break;
      case "error":
        setError(e.message);
        break;
      case "done":
        patchRun(e.runId, (r) => ({ ...r, status: e.status, finishedAt: new Date().toISOString() }));
        setLog((l) => [...l, e.status === "done" ? "Done." : `Run ${e.status}.`]);
        break;
    }
  }

  function stop() {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
    setBusy(null);
    setRuns((rs) => rs.map((r) => (r.status === "running" ? { ...r, status: "stopped" } : r)));
  }

  function tryOption(direction: string) {
    void runGenerate({ direction, basePrompt: selected?.prompt });
  }

  async function rename(newName: string) {
    const trimmed = newName.trim();
    if (!projectId || !trimmed || trimmed === name) return;
    setName(trimmed);
    await api(`/api/projects/${projectId}`, "PATCH", { name: trimmed }).catch((e) => setError((e as Error).message));
  }

  async function removeRun(run: RunView) {
    if (!projectId || !confirm(`Delete run ${run.number} and its ${run.generations.length} images?`)) return;
    try {
      await api(`/api/projects/${projectId}/runs/${run.id}`, "DELETE");
      setRuns((rs) => rs.filter((r) => r.id !== run.id));
      if (run.generations.some((g) => g.id === selectedId)) setSelectedId(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // ---------------- render ----------------
  if (loading) {
    return (
      <div className={styles.shell}>
        <div className={styles.busy}>
          <span className={styles.spinner} /> Opening project…
        </div>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          <span className={styles.logo}>◆</span> Detail Studio
        </Link>
        {projectId ? (
          <input
            className={styles.projectName}
            defaultValue={name}
            key={name}
            aria-label="Project name"
            onBlur={(e) => void rename(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <span className={styles.projectNameStatic}>New project</span>
        )}
        <nav className={styles.steps}>
          {(["upload", "questions", "create"] as Stage[]).map((s, i) => (
            <button
              key={s}
              className={`${styles.step} ${stage === s ? styles.stepActive : ""}`}
              disabled={s !== "upload" && !analysis}
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
          {running && <button className={styles.linkBtn} onClick={stop}>Stop</button>}
        </div>
      )}

      {stage === "upload" && (
        <section className={styles.panel}>
          <h2>1 · {projectId ? "Your reference images" : "Upload your reference images"}</h2>
          {!projectId ? (
            <>
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
            </>
          ) : (
            <p className={styles.muted}>These images are saved with the project. Start a new project to use different ones.</p>
          )}
          {images.length > 0 && (
            <div className={styles.thumbs}>
              {images.map((img, i) => (
                <figure key={i} className={styles.thumb}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={img.preview} alt={img.name ?? `Reference ${i + 1}`} />
                  {!projectId && (
                    <button aria-label="Remove image" onClick={() => setImages((p) => p.filter((_, j) => j !== i))}>×</button>
                  )}
                </figure>
              ))}
            </div>
          )}
          <div className={styles.actions}>
            <button className={styles.primary} disabled={images.length === 0 || !!busy} onClick={runAnalysis}>
              {analysis ? "Analyse again" : "Analyse images"}
            </button>
            {analysis && <button className={styles.ghost} onClick={() => setStage("questions")}>Continue to questions</button>}
          </div>
          {analysis && <AnalysisCard analysis={analysis} />}
        </section>
      )}

      {stage === "questions" && analysis && (
        <section className={styles.panel}>
          <h2>2 · A few questions about your images</h2>
          <p className={styles.muted}>Answer what matters to you. Skipped questions use the suggested default. Answers save automatically.</p>
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
              <select value={settings.count} onChange={(e) => set("count", Number(e.target.value))}>
                {[1, 2, 3, 4].map((n) => <option key={n}>{n}</option>)}
              </select>
            </label>
            <label>
              Self-correction rounds
              <select value={settings.maxRounds} onChange={(e) => set("maxRounds", Number(e.target.value))}>
                {[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}
              </select>
            </label>
            <label>
              Accept at score
              <input
                type="number"
                min={50}
                max={100}
                value={settings.targetScore}
                onChange={(e) => set("targetScore", Math.min(100, Math.max(0, Number(e.target.value) || 0)))}
              />
            </label>
            <label>
              Aspect
              <select value={settings.aspect} onChange={(e) => set("aspect", e.target.value)}>
                {Object.keys(ASPECTS).map((a) => <option key={a}>{a}</option>)}
              </select>
            </label>
            <label className={styles.check}>
              <input type="checkbox" checked={settings.useReference} onChange={(e) => set("useReference", e.target.checked)} />
              Start from my first image (image-to-image)
            </label>
            {settings.useReference && (
              <label>
                Change amount {settings.referenceStrength.toFixed(2)}
                <input
                  type="range"
                  min={0.1}
                  max={0.9}
                  step={0.05}
                  value={settings.referenceStrength}
                  onChange={(e) => set("referenceStrength", Number(e.target.value))}
                />
              </label>
            )}
          </div>
          <div className={styles.actions}>
            <button className={styles.primary} disabled={!!busy} onClick={() => void runGenerate()}>
              Generate
            </button>
            {runs.length > 0 && <button className={styles.ghost} onClick={() => setStage("create")}>View history</button>}
            <button className={styles.ghost} onClick={() => setStage("upload")}>Back</button>
          </div>
        </section>
      )}

      {stage === "create" && (
        <section className={styles.create}>
          <div className={styles.galleryCol}>
            <h2>3 · Output space</h2>
            <p className={styles.muted}>
              {runs.length === 0
                ? "Images appear here as they are generated and checked."
                : `${runs.length} run${runs.length === 1 ? "" : "s"} · ${allGenerations.length} images, newest run first. Everything is saved.`}
            </p>
            {log.length > 0 && (
              <details className={styles.log}>
                <summary>Activity log ({log.length})</summary>
                <ol>{log.map((l, i) => <li key={i}>{l}</li>)}</ol>
              </details>
            )}
            {runs.map((run) => (
              <div key={run.id} className={styles.run}>
                <div className={styles.runHead}>
                  <div>
                    <strong>Run {run.number}</strong>
                    <span className={styles.runDir}>{run.direction ? ` · ${run.direction}` : " · From your answers"}</span>
                  </div>
                  <div className={styles.runMeta}>
                    <span className={`${styles.runStatus} ${styles[`st_${run.status}`] ?? ""}`}>{run.status}</span>
                    <span>{formatTime(run.startedAt)}</span>
                    {run.status !== "running" && (
                      <button className={styles.linkBtn} onClick={() => void removeRun(run)} aria-label={`Delete run ${run.number}`}>
                        Delete
                      </button>
                    )}
                  </div>
                </div>
                {run.error && <div className={styles.runError}>{run.error}</div>}
                {run.generations.length === 0 ? (
                  <p className={styles.muted}>{run.status === "running" ? "Working…" : "No images in this run."}</p>
                ) : (
                  <div className={styles.gallery}>
                    {run.generations.map((g) => (
                      <button
                        key={g.id}
                        className={`${styles.card} ${g.id === selectedId ? styles.cardOn : ""}`}
                        onClick={() => setSelectedId(g.id)}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={g.image} alt={g.prompt} loading="lazy" />
                        <div className={styles.cardMeta}>
                          <span>{g.variantTitle} · round {g.round}</span>
                          <ScoreBadge g={g} />
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <aside className={styles.side}>
            {selected ? (
              <SelectedPanel g={selected} runNumber={runs.find((r) => r.id === selected.runId)?.number} />
            ) : (
              <p className={styles.muted}>Select an image to see its prompt and review.</p>
            )}

            <div className={styles.optionsBox}>
              <h3>Options to try{optionsRun ? ` · from run ${optionsRun.number}` : ""}</h3>
              {!optionsRun?.options.length && <p className={styles.muted}>Suggestions appear after a run finishes.</p>}
              <div className={styles.optionList}>
                {optionsRun?.options.map((o) => (
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
                <Link className={styles.ghost} href="/">All projects</Link>
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
  const s = status;
  const problems = [!s.claudeKey && "no Claude API key", !s.generator.ok && `generator ${s.generator.error}`].filter(Boolean);
  return (
    <div className={`${styles.pill} ${problems.length ? styles.pillWarn : ""}`} title={problems.join(", ")}>
      {s.backend === "mock" ? "mock images" : s.generator.model ?? "local generator"}
      {problems.length > 0 && ` · ${problems.join(", ")}`}
    </div>
  );
}

function ScoreBadge({ g }: { g: Generation }) {
  if (!g.critique) return <span className={styles.badge}>checking…</span>;
  const s = Math.round(g.critique.score);
  return <span className={`${styles.badge} ${s >= 85 ? styles.good : s >= 60 ? styles.ok : styles.bad}`}>{s}</span>;
}

function SelectedPanel({ g, runNumber }: { g: Generation; runNumber?: number }) {
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
        <dt>Run · seed · model</dt>
        <dd>
          {runNumber ? `Run ${runNumber}, ` : ""}
          {g.variantTitle} round {g.round} · {g.seed} · {g.backend}
          {g.createdAt ? ` · ${formatTime(g.createdAt)}` : ""}
        </dd>
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
