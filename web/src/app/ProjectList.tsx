"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { ProjectSummary } from "@/lib/store";
import styles from "./studio.module.css";

function ago(iso: string) {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export default function ProjectList() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((j) => setProjects(j.projects ?? []))
      .catch(() => setError("Could not load projects."));
  }, []);

  async function remove(p: ProjectSummary) {
    if (!confirm(`Delete "${p.name}" and all of its ${p.imageCount} generated images? This can't be undone.`)) return;
    const res = await fetch(`/api/projects/${p.id}`, { method: "DELETE" });
    if (res.ok) setProjects((ps) => ps?.filter((x) => x.id !== p.id) ?? null);
    else setError("Could not delete the project.");
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}>
          <span className={styles.logo}>◆</span> Detail Studio
        </Link>
        <div className={styles.spacer} />
        <Link href="/new" className={styles.primary}>New project</Link>
      </header>

      {error && <div className={styles.error} role="alert">{error}</div>}

      <h2>Your projects</h2>
      {projects === null ? (
        <div className={styles.busy}>
          <span className={styles.spinner} /> Loading…
        </div>
      ) : projects.length === 0 ? (
        <div className={styles.empty}>
          <p>No projects yet. Upload a few reference images to start your first one.</p>
          <Link href="/new" className={styles.primary}>Start a project</Link>
        </div>
      ) : (
        <div className={styles.projectGrid}>
          {projects.map((p) => (
            <div key={p.id} className={styles.projectCard}>
              <Link href={`/p/${p.id}`} className={styles.projectLink}>
                {p.cover ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={p.cover} alt="" loading="lazy" />
                ) : (
                  <div className={styles.noCover} />
                )}
                <div className={styles.projectInfo}>
                  <strong>{p.name}</strong>
                  <span>
                    {p.analysed ? `${p.runCount} run${p.runCount === 1 ? "" : "s"} · ${p.imageCount} images` : "Not analysed yet"}
                    {" · "}
                    {ago(p.updatedAt)}
                  </span>
                </div>
              </Link>
              <button className={styles.projectDelete} onClick={() => void remove(p)} aria-label={`Delete ${p.name}`}>
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
