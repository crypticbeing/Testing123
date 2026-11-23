import "server-only";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Analysis, Generation, InputImage, ProjectSettings, Question, RunInfo } from "./types";
import { DEFAULT_SETTINGS } from "./types";

/**
 * File-based project storage.
 *
 *   data/projects/<id>/project.json     name, analysis, questions, answers, settings, selection
 *   data/projects/<id>/runs/<runId>.json one file per generation run (the history)
 *   data/projects/<id>/images/*         reference uploads and every generated image
 *
 * Writes go through a per-project lock and an atomic rename, so concurrent requests can't corrupt files.
 */

const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.join(process.cwd(), "data"));
const PROJECTS_DIR = path.join(DATA_DIR, "projects");
const ID_RE = /^[a-z0-9-]{8,64}$/;
const FILE_RE = /^[a-z0-9-]+\.(png|jpg|jpeg|webp|gif)$/;

export interface StoredImage {
  file: string;
  mediaType: InputImage["mediaType"];
  name?: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  references: StoredImage[];
  analysis: Analysis | null;
  questions: Question[];
  answers: Record<string, string>;
  settings: ProjectSettings;
  selectedId: string | null;
  cover: string | null; // image URL used on the projects page
  coverScore: number;
  runSeq: number; // last run number handed out (runs keep their number after others are deleted)
  imageCount: number;
}

export type Run = RunInfo & { generations: Generation[] };

export type ProjectSummary = Pick<
  Project,
  "id" | "name" | "createdAt" | "updatedAt" | "cover" | "imageCount"
> & { analysed: boolean; runCount: number };

// ---------- paths + low-level helpers ----------
function projectDir(id: string): string {
  if (!ID_RE.test(id)) throw new NotFoundError("Unknown project");
  return path.join(PROJECTS_DIR, id);
}

export class NotFoundError extends Error {}

export function imageUrl(projectId: string, file: string): string {
  return `/api/projects/${projectId}/images/${file}`;
}

export function imageFilePath(projectId: string, file: string): string {
  if (!FILE_RE.test(file)) throw new NotFoundError("Unknown image");
  return path.join(projectDir(projectId), "images", file);
}

async function readJson<T>(file: string): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new NotFoundError("Not found");
    throw err;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

// Shared across route bundles via globalThis (Next may load this module once per route).
const g = globalThis as unknown as { __studioLocks?: Map<string, Promise<unknown>>; __studioActiveRuns?: Set<string> };
const locks = (g.__studioLocks ??= new Map());
const activeRuns = (g.__studioActiveRuns ??= new Set());

async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next);
  try {
    return await next;
  } finally {
    if (locks.get(key) === next) locks.delete(key);
  }
}

const EXT: Record<InputImage["mediaType"], string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

// ---------- projects ----------
export async function createProject(images: InputImage[], name?: string): Promise<Project> {
  const id = randomUUID();
  const dir = projectDir(id);
  await fs.mkdir(path.join(dir, "images"), { recursive: true });
  await fs.mkdir(path.join(dir, "runs"), { recursive: true });

  const references: StoredImage[] = [];
  for (const [i, img] of images.entries()) {
    const file = `ref-${i}.${EXT[img.mediaType]}`;
    await fs.writeFile(path.join(dir, "images", file), Buffer.from(img.data, "base64"));
    references.push({ file, mediaType: img.mediaType, name: img.name });
  }

  const now = new Date().toISOString();
  const project: Project = {
    id,
    name: name?.trim() || "Untitled project",
    createdAt: now,
    updatedAt: now,
    references,
    analysis: null,
    questions: [],
    answers: {},
    settings: { ...DEFAULT_SETTINGS },
    selectedId: null,
    cover: references[0] ? imageUrl(id, references[0].file) : null,
    coverScore: -1,
    runSeq: 0,
    imageCount: 0,
  };
  await writeJson(path.join(dir, "project.json"), project);
  return project;
}

export async function getProject(id: string): Promise<Project> {
  return readJson<Project>(path.join(projectDir(id), "project.json"));
}

export async function updateProject(id: string, mutate: (p: Project) => void): Promise<Project> {
  return withLock(id, async () => {
    const file = path.join(projectDir(id), "project.json");
    const project = await readJson<Project>(file);
    mutate(project);
    project.updatedAt = new Date().toISOString();
    await writeJson(file, project);
    return project;
  });
}

export async function deleteProject(id: string): Promise<void> {
  await withLock(id, () => fs.rm(projectDir(id), { recursive: true, force: true }));
}

export async function listProjects(): Promise<ProjectSummary[]> {
  let ids: string[];
  try {
    ids = await fs.readdir(PROJECTS_DIR);
  } catch {
    return [];
  }
  const out: ProjectSummary[] = [];
  for (const id of ids) {
    try {
      const p = await getProject(id);
      out.push({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        cover: p.cover,
        runCount: await countRuns(p.id),
        imageCount: p.imageCount,
        analysed: p.analysis !== null,
      });
    } catch {
      // skip folders that aren't valid projects
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function readReferenceImages(project: Project): Promise<InputImage[]> {
  return Promise.all(
    project.references.map(async (r) => ({
      mediaType: r.mediaType,
      name: r.name,
      data: (await fs.readFile(imageFilePath(project.id, r.file))).toString("base64"),
    })),
  );
}

export async function saveGeneratedImage(projectId: string, base64Png: string): Promise<string> {
  const file = `gen-${randomUUID()}.png`;
  await fs.writeFile(imageFilePath(projectId, file), Buffer.from(base64Png, "base64"));
  return imageUrl(projectId, file);
}

// ---------- runs (history) ----------
function runFile(projectId: string, runId: string): string {
  if (!ID_RE.test(runId)) throw new NotFoundError("Unknown run");
  return path.join(projectDir(projectId), "runs", `${runId}.json`);
}

export async function createRun(
  projectId: string,
  init: Pick<Run, "direction" | "basePrompt" | "settings">,
): Promise<Run> {
  const project = await updateProject(projectId, (p) => {
    p.runSeq = (p.runSeq ?? 0) + 1;
  });
  const run: Run = {
    id: randomUUID(),
    number: project.runSeq,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    plans: [],
    generations: [],
    options: [],
    ...init,
  };
  activeRuns.add(run.id);
  await writeJson(runFile(projectId, run.id), run);
  return run;
}

export async function updateRun(projectId: string, runId: string, mutate: (r: Run) => void): Promise<Run> {
  return withLock(`${projectId}/${runId}`, async () => {
    const file = runFile(projectId, runId);
    const run = await readJson<Run>(file);
    mutate(run);
    if (run.status !== "running") {
      run.finishedAt ??= new Date().toISOString();
      activeRuns.delete(run.id);
    }
    await writeJson(file, run);
    return run;
  });
}

async function countRuns(projectId: string): Promise<number> {
  try {
    return (await fs.readdir(path.join(projectDir(projectId), "runs"))).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export async function listRuns(projectId: string): Promise<Run[]> {
  const dir = path.join(projectDir(projectId), "runs");
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const runs = await Promise.all(files.map((f) => readJson<Run>(path.join(dir, f)).catch(() => null)));
  return runs
    .filter((r): r is Run => r !== null)
    .map((r) => (r.status === "running" && !activeRuns.has(r.id) ? { ...r, status: "interrupted" as const } : r))
    .sort((a, b) => b.number - a.number);
}

export async function deleteRun(projectId: string, runId: string): Promise<void> {
  const file = runFile(projectId, runId);
  const run = await readJson<Run>(file);
  if (run.status === "running" && activeRuns.has(run.id)) throw new Error("Stop the run before deleting it.");
  await fs.rm(file, { force: true });
  const files = run.generations.map((gen) => gen.image.split("/").pop()!).filter((f) => FILE_RE.test(f));
  await Promise.all(files.map((f) => fs.rm(imageFilePath(projectId, f), { force: true })));
  await updateProject(projectId, (p) => {
    p.imageCount = Math.max(0, p.imageCount - run.generations.length);
    if (run.generations.some((gen) => gen.image === p.cover)) {
      p.cover = p.references[0] ? imageUrl(p.id, p.references[0].file) : null;
      p.coverScore = -1;
    }
    if (run.generations.some((gen) => gen.id === p.selectedId)) p.selectedId = null;
  });
}
