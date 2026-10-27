"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import { Seal } from "./seal";
import type { DocRecord, EvalQuestionSet, EvalResultRow, EvalSummary } from "@/lib/types";

type Config = {
  storageMode: "blob" | "local";
  aiMode: "groq" | "mock" | "missing";
  chatModel: string;
  fallbackModel: string;
  evalModel: string;
  embedMode: "gemini" | "mock" | "none";
  embedModel: string;
};
type DocsRes = { docs: DocRecord[]; chunkCount: number; stats: { duplicateFilesBlocked: number; duplicateChunksSkipped: number } };

type QueueItem = {
  key: string;
  file: File;
  state: "hashing" | "duplicate" | "uploading" | "indexing" | "done" | "skipped" | "error";
  progress?: number;
  message?: string;
  existing?: { name: string; uploadedAt: string };
  match?: "file" | "content";
  sha?: string;
};

const ACCEPT = ".pdf,.docx,.txt,.md";
const MAX = 10 * 1024 * 1024;

async function sha256Hex(file: File) {
  const buf = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const fmtDate = (s: string) =>
  new Date(s).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const pct = (x: number) => `${Math.round(x * 100)}%`;
const fmtSize = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

export default function AdminDashboard() {
  const [config, setConfig] = useState<Config | null>(null);
  const [docs, setDocs] = useState<DocsRes | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);
  // Remove uses an inline two-step confirm (browser pop-ups can be blocked or suppressed).
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [libError, setLibError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const running = useRef(false);

  const refreshDocs = useCallback(async () => {
    const r = await fetch("/api/admin/docs", { cache: "no-store" });
    if (r.status === 401) window.location.reload();
    if (r.ok) setDocs(await r.json());
  }, []);

  useEffect(() => {
    fetch("/api/admin/config").then(async (r) => r.ok && setConfig(await r.json()));
    fetch("/api/admin/docs", { cache: "no-store" }).then(async (r) => r.ok && setDocs(await r.json()));
  }, []);

  const update = (key: string, patch: Partial<QueueItem>) =>
    setQueue((q) => q.map((it) => (it.key === key ? { ...it, ...patch } : it)));

  async function sendToIndex(item: QueueItem, replace: boolean) {
    const { file, key } = item;
    try {
      let res: Response;
      if (config?.storageMode === "blob") {
        update(key, { state: "uploading", progress: 0 });
        const safe = file.name.replace(/[^\w.-]+/g, "_");
        const blob = await upload(`uploads/${item.sha!.slice(0, 16)}-${safe}`, file, {
          access: "private",
          handleUploadUrl: "/api/admin/blob-upload",
          multipart: file.size > 5 * 1024 * 1024,
          onUploadProgress: (p) => update(key, { progress: p.percentage }),
        });
        update(key, { state: "indexing" });
        res = await fetch("/api/admin/ingest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pathname: blob.pathname, name: file.name, replace }),
        });
      } else {
        update(key, { state: "indexing" });
        const form = new FormData();
        form.append("file", file);
        if (replace) form.append("replace", "1");
        res = await fetch("/api/admin/ingest", { method: "POST", body: form });
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.duplicate) {
        update(key, { state: "duplicate", existing: data.existing, match: data.match, message: data.error });
      } else if (!res.ok) {
        update(key, { state: "error", message: data.error ?? "Indexing failed." });
      } else {
        const bits = [`${data.chunksCreated} passages indexed`];
        if (data.duplicateChunksSkipped) bits.push(`${data.duplicateChunksSkipped} repeated passages skipped`);
        if (data.boilerplateLinesRemoved) bits.push(`${data.boilerplateLinesRemoved} header and footer lines removed`);
        const note = data.keywordOnly ? " The embedding service didn't respond, so it's keyword-searchable for now." : "";
        update(key, { state: "done", message: (data.replaced ? "Replaced. " : "") + bits.join(", ") + "." + note });
      }
    } catch (e) {
      update(key, { state: "error", message: (e as Error).message || "Upload failed." });
    }
    await refreshDocs();
  }

  async function processQueue(items: QueueItem[]) {
    if (running.current) return;
    running.current = true;
    for (const item of items) {
      const { file, key } = item;
      if (file.size > MAX) {
        update(key, { state: "error", message: "File is larger than 10 MB." });
        continue;
      }
      if (!/\.(pdf|docx|txt|md)$/i.test(file.name)) {
        update(key, { state: "error", message: "Use PDF, Word (.docx), .txt or .md." });
        continue;
      }
      const sha = await sha256Hex(file);
      update(key, { sha });
      const chk = await fetch("/api/admin/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sha256: sha }),
      }).then((r) => r.json());
      if (chk.duplicate) {
        update(key, { state: "duplicate", existing: chk.existing, match: "file", message: "This exact file is already in the library." });
        continue;
      }
      await sendToIndex({ ...item, sha }, false);
    }
    running.current = false;
  }

  function addFiles(list: FileList | null) {
    if (!list?.length) return;
    const items: QueueItem[] = [...list].map((file) => ({ key: crypto.randomUUID(), file, state: "hashing" }));
    setQueue((q) => [...items, ...q]);
    processQueue(items);
  }

  async function removeDocs(target: DocRecord | "all") {
    const key = target === "all" ? "all" : target.id;
    setRemoving(key);
    setLibError("");
    try {
      const qs = target === "all" ? "all=1" : `id=${encodeURIComponent(target.id)}`;
      const r = await fetch(`/api/admin/docs?${qs}`, { method: "DELETE" });
      if (r.status === 401) {
        window.location.reload();
        return;
      }
      const data = await r.json().catch(() => ({}));
      if (!r.ok && r.status !== 404) {
        setLibError(data.error ?? "Couldn't remove the document. Try again.");
      } else if (data.docs) {
        setDocs({ docs: data.docs, chunkCount: data.chunkCount, stats: data.stats });
      } else {
        await refreshDocs();
      }
    } catch {
      setLibError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setRemoving(null);
      setConfirming(null);
    }
  }

  return (
    <div className="admin">
      <header className="topbar">
        <span className="brand">
          <Seal />
          <span>Document admin</span>
        </span>
        <div className="row-gap">
          <a className="btn btn-quiet" href="/" target="_blank" rel="noreferrer">
            Open public chat
          </a>
        </div>
      </header>

      <main className="admin-main">
        {config && (
          <div className="env-line">
            <span className={"pill" + (config.aiMode === "groq" ? " ok" : " warn")}>
              {config.aiMode === "groq"
                ? `Groq answers: ${config.chatModel} · tests: ${config.evalModel}`
                : config.aiMode === "mock"
                  ? "Offline test mode (MOCK_AI): answers are not real"
                  : "GROQ_API_KEY missing: chat and evaluation are off"}
            </span>
            <span className={"pill" + (config.embedMode === "none" ? "" : " ok")}>
              {config.embedMode === "gemini"
                ? `Search: keywords + meaning (${config.embedModel})`
                : config.embedMode === "mock"
                  ? "Search: keywords + mock embeddings"
                  : "Search: keywords only (add GEMINI_API_KEY for meaning search)"}
            </span>
            <span className="pill">{config.storageMode === "blob" ? "Storage: private Vercel Blob" : "Storage: local .data folder"}</span>
          </div>
        )}

        <section className="stats" aria-label="Library totals">
          <Stat label="Documents" value={docs?.docs.length} />
          <Stat label="Passages indexed" value={docs?.chunkCount} />
          <Stat label="Duplicate uploads blocked" value={docs?.stats.duplicateFilesBlocked} />
          <Stat label="Repeated passages skipped" value={docs?.stats.duplicateChunksSkipped} />
        </section>

        <section className="panel">
          <h2 className="panel-title">Upload documents</h2>
          <p className="panel-sub">
            Each file is checked by fingerprint first, so the same document can&apos;t be indexed twice. Repeated headers,
            footers and passages are removed before indexing.
          </p>
          <div
            className={"drop" + (dragging ? " is-drag" : "")}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              addFiles(e.dataTransfer.files);
            }}
          >
            <input
              ref={fileInput}
              type="file"
              accept={ACCEPT}
              multiple
              hidden
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <button className="btn btn-seal" onClick={() => fileInput.current?.click()} disabled={config?.aiMode === "missing"}>
              Choose files
            </button>
            <span className="muted">or drop them here. PDF, Word (.docx), .txt or .md, up to 10 MB each.</span>
          </div>

          {queue.length > 0 && (
            <ul className="queue">
              {queue.map((it) => (
                <li key={it.key} className={"q-item is-" + it.state}>
                  <div className="q-main">
                    <span className="q-name">{it.file.name}</span>
                    <span className="q-state">
                      {it.state === "hashing" && "Checking for duplicates…"}
                      {it.state === "uploading" && `Uploading ${Math.round(it.progress ?? 0)}%`}
                      {it.state === "indexing" && "Reading, splitting and indexing…"}
                      {it.state === "done" && "Indexed"}
                      {it.state === "duplicate" && "Duplicate"}
                      {it.state === "skipped" && "Skipped"}
                      {it.state === "error" && "Failed"}
                    </span>
                  </div>
                  {it.message && <p className="q-msg">{it.message}</p>}
                  {it.state === "duplicate" && it.existing && it.match === "file" && (
                    <div className="q-actions">
                      <span className="muted">
                        Uploaded {fmtDate(it.existing.uploadedAt)} as “{it.existing.name}”.
                      </span>
                      <button className="btn small" onClick={() => sendToIndex(it, true)}>
                        Replace existing
                      </button>
                      <button className="btn btn-quiet small" onClick={() => update(it.key, { state: "skipped", message: "Kept the existing copy." })}>
                        Keep existing
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Library</h2>
            {docs && docs.docs.length > 1 &&
              (confirming === "all" ? (
                <div className="row-gap">
                  <span className="danger-text small-text">Remove all {docs.docs.length} documents?</span>
                  <button className="btn small btn-danger" onClick={() => removeDocs("all")} disabled={removing === "all"}>
                    {removing === "all" ? "Removing…" : "Yes, remove all"}
                  </button>
                  <button className="btn btn-quiet small" onClick={() => setConfirming(null)} disabled={removing === "all"}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button className="btn btn-quiet small danger-text" onClick={() => setConfirming("all")} disabled={!!removing}>
                  Remove all
                </button>
              ))}
          </div>
          {libError && (
            <p className="notice notice-danger" role="alert">
              {libError}
            </p>
          )}
          {docs && config && config.embedMode !== "none" && docs.docs.some((d) => (d.embeddedCount ?? 0) < d.chunkCount) && (
            <EmbedBackfill onDone={refreshDocs} missing={docs.docs.reduce((a, d) => a + d.chunkCount - (d.embeddedCount ?? 0), 0)} />
          )}
          {!docs ? (
            <p className="muted">Loading…</p>
          ) : docs.docs.length === 0 ? (
            <p className="muted">No documents yet. Upload your first policy document above; it appears in the public chat as soon as it&apos;s indexed.</p>
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Document</th>
                    <th className="num">Pages</th>
                    <th className="num">Passages</th>
                    <th className="num">Repeats skipped</th>
                    <th>Added</th>
                    <th aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {docs.docs.map((d) => (
                    <tr key={d.id}>
                      <td>
                        <span className="doc-name">{d.name}</span>
                        <span className="muted small-text">
                          {fmtSize(d.size)} · fingerprint {d.sha256.slice(0, 10)}
                          {config?.embedMode !== "none" && (d.embeddedCount ?? 0) < d.chunkCount ? " · keyword search only" : ""}
                        </span>
                      </td>
                      <td className="num">{d.pages}</td>
                      <td className="num">{d.chunkCount}</td>
                      <td className="num">{d.duplicateChunksSkipped}</td>
                      <td className="nowrap">{fmtDate(d.uploadedAt)}</td>
                      <td className="nowrap">
                        {confirming === d.id ? (
                          <div className="row-gap">
                            <button className="btn small btn-danger" onClick={() => removeDocs(d)} disabled={removing === d.id}>
                              {removing === d.id ? "Removing…" : "Confirm"}
                            </button>
                            <button className="btn btn-quiet small" onClick={() => setConfirming(null)} disabled={removing === d.id}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            className="btn btn-quiet small danger-text"
                            onClick={() => setConfirming(d.id)}
                            disabled={!!removing}
                            aria-label={`Remove ${d.name}`}
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <Evaluation hasDocs={(docs?.chunkCount ?? 0) > 0} aiReady={config?.aiMode !== "missing"} />
      </main>
    </div>
  );
}

/** Adds embeddings to passages that only have keyword search, in batches. */
function EmbedBackfill({ missing, onDone }: { missing: number; onDone: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  async function go() {
    setBusy(true);
    setMsg("");
    try {
      for (let i = 0; i < 40; i++) {
        const r = await fetch("/api/admin/embeddings", { method: "POST" });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          setMsg(data.error ?? "Couldn't add meaning search. Try again later.");
          break;
        }
        if (!data.remaining || !data.added) break;
        setMsg(`${data.remaining} passages left…`);
      }
    } finally {
      await onDone();
      setBusy(false);
    }
  }
  return (
    <div className="notice notice-warn backfill" role="status">
      <span>
        {missing} passage{missing === 1 ? " is" : "s are"} searchable by keywords only. {msg}
      </span>
      <button className="btn small" onClick={go} disabled={busy}>
        {busy ? "Adding…" : "Add meaning search"}
      </button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value?: number }) {
  return (
    <div className="stat">
      <span className="stat-value">{value ?? "–"}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

// ---------------------------------------------------------------- evaluation

function Evaluation({ hasDocs, aiReady }: { hasDocs: boolean; aiReady: boolean }) {
  const [set, setSet] = useState<EvalQuestionSet | null>(null);
  const [summary, setSummary] = useState<EvalSummary | null>(null);
  const [building, setBuilding] = useState(false);
  const [run, setRun] = useState<{ done: number; total: number; rows: EvalResultRow[]; failed: number; waiting?: number } | null>(
    null
  );
  const [error, setError] = useState("");
  const [showQs, setShowQs] = useState(false);

  useEffect(() => {
    // questions first: loading them also clears any left over from removed documents
    fetch("/api/admin/eval/questions")
      .then(async (r) => r.ok && setSet((await r.json()).set))
      .finally(() => fetch("/api/admin/eval/results").then(async (r) => r.ok && setSummary((await r.json()).summary)));
  }, []);

  async function build() {
    setBuilding(true);
    setError("");
    const r = await fetch("/api/admin/eval/questions", { method: "POST" });
    const data = await r.json().catch(() => ({}));
    setBuilding(false);
    if (r.ok) {
      setSet(data.set);
      setShowQs(true);
    } else setError(data.error ?? "Couldn't build the test set.");
  }

  async function runAll() {
    if (!set) return;
    setError("");
    const rows: EvalResultRow[] = [];
    let failed = 0;
    let stopped = "";
    const total = set.questions.length;
    setRun({ done: 0, total, rows, failed });
    for (const q of set.questions) {
      let attempt = 0;
      for (;;) {
        const r = await fetch("/api/admin/eval/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: q.id }),
        }).catch(() => null);
        const data = r ? await r.json().catch(() => ({})) : {};
        if (r?.ok) {
          rows.push(data.row);
          break;
        }
        if (r?.status === 429 && data.rateLimit === "day") {
          stopped = data.error;
          break;
        }
        if (r?.status === 429 && attempt < 4) {
          // Groq's per-minute limit: wait it out, then retry the same question
          attempt++;
          const wait = Math.min(90, Math.max(5, data.retryAfterS ?? 20));
          for (let left = wait; left > 0; left--) {
            setRun({ done: rows.length + failed, total, rows: [...rows], failed, waiting: left });
            await new Promise((res) => setTimeout(res, 1000));
          }
          continue;
        }
        failed++;
        break;
      }
      setRun({ done: rows.length + failed, total, rows: [...rows], failed });
      if (stopped) break;
    }
    if (!rows.length) {
      setError(stopped || "Every question failed. Check the Groq key in the Vercel settings, then try again.");
      setRun(null);
      return;
    }
    const r = await fetch("/api/admin/eval/results", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows }),
    });
    const data = await r.json().catch(() => ({}));
    if (r.ok) setSummary(data.summary);
    else setError(data.error ?? "Couldn't save results.");
    const skipped = total - rows.length;
    if (stopped) setError(`${stopped} Scores cover the ${rows.length} questions finished so far.`);
    else if (skipped) setError(`${skipped} question${skipped > 1 ? "s" : ""} failed and were left out of the scores.`);
    setRun(null);
  }

  function download(kind: "json" | "csv") {
    if (!summary) return;
    let blob: Blob;
    if (kind === "json") blob = new Blob([JSON.stringify(summary, null, 2)], { type: "application/json" });
    else {
      const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      const head = ["id", "question", "expected_answer", "gold_doc", "gold_page", "improved_hit", "improved_rank", "improved_dups", "baseline_hit", "baseline_rank", "baseline_dups", "faithful", "correct", "latency_ms", "answer"];
      const lines = summary.rows.map((r) =>
        [r.id, r.question, r.expectedAnswer, r.docName, r.page, r.improved.hit, r.improved.rank, r.improved.duplicatesInTopK, r.naive.hit, r.naive.rank, r.naive.duplicatesInTopK, r.faithful, r.correct, r.latencyMs, r.answer].map(esc).join(",")
      );
      blob = new Blob([head.join(",") + "\n" + lines.join("\n")], { type: "text/csv" });
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `eval-results.${kind}`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <section className="panel">
      <h2 className="panel-title">Evaluation</h2>
      <p className="panel-sub">
        The test set has 25 questions. Each one is written from one specific indexed passage, so the right page is known. The run compares the
        improved search with the class-notebook baseline (every file indexed twice, plain top 5), then grades each answer.
      </p>

      <div className="row-gap wrap">
        <button className="btn" onClick={build} disabled={building || !!run || !hasDocs || !aiReady}>
          {building ? "Writing questions…" : set ? "Rebuild test set" : "Build 25 test questions"}
        </button>
        <button className="btn btn-seal" onClick={runAll} disabled={!set || !!run || building || !aiReady}>
          {run
            ? run.waiting
              ? `Groq limit, resuming in ${run.waiting}s…`
              : `Running ${run.done + 1 > run.total ? run.total : run.done + 1} of ${run.total}…`
            : "Run evaluation"}
        </button>
        {set && (
          <button className="btn btn-quiet" onClick={() => setShowQs((v) => !v)} aria-expanded={showQs}>
            {showQs ? "Hide questions" : `View ${set.questions.length} questions`}
          </button>
        )}
      </div>
      {!hasDocs && <p className="muted top-gap">Upload documents first; questions are written from them.</p>}
      {error && (
        <p className="notice notice-warn top-gap" role="alert">
          {error}
        </p>
      )}

      {run && (
        <div className="progress top-gap" role="progressbar" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.done}>
          <div style={{ width: `${(run.done / run.total) * 100}%` }} />
        </div>
      )}

      {showQs && set && (
        <div className="qset top-gap">
          <p className="muted small-text">{set.method} Built {fmtDate(set.createdAt)}.</p>
          <ol>
            {set.questions.map((q) => (
              <li key={q.id}>
                {q.question}
                <span className="muted small-text">
                  {" "}
                  · {q.docName}, p. {q.page}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {summary && <Results summary={summary} onDownload={download} />}
    </section>
  );
}

function Results({ summary, onDownload }: { summary: EvalSummary; onDownload: (k: "json" | "csv") => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const rows: { label: string; hint: string; improved: string; naive: string; better: boolean }[] = [
    {
      label: "Right page in top 5",
      hint: "Share of questions where the source page was retrieved",
      improved: pct(summary.improved.hitRate),
      naive: pct(summary.naive.hitRate),
      better: summary.improved.hitRate >= summary.naive.hitRate,
    },
    {
      label: "Mean reciprocal rank",
      hint: "1.0 means the right page was always ranked first",
      improved: summary.improved.mrr.toFixed(2),
      naive: summary.naive.mrr.toFixed(2),
      better: summary.improved.mrr >= summary.naive.mrr,
    },
    {
      label: "Duplicate results in top 5",
      hint: "Slots wasted on a repeat of another result",
      improved: pct(summary.improved.duplicateRate),
      naive: pct(summary.naive.duplicateRate),
      better: summary.improved.duplicateRate <= summary.naive.duplicateRate,
    },
  ];
  return (
    <div className="results top-gap">
      <div className="results-head">
        <p className="muted small-text">
          Last run {fmtDate(summary.runAt)} · {summary.total} questions ·{" "}
          {summary.aiMode === "mock" ? "offline test mode" : `answers ${summary.chatModel}${summary.judgeModel ? `, graded by ${summary.judgeModel}` : ""}`}
          {summary.searchMode ? ` · ${summary.searchMode === "hybrid" ? "keyword + meaning search" : summary.searchMode === "keyword" ? "keyword search" : "mixed search"}` : ""}
        </p>
        <div className="row-gap">
          <button className="btn btn-quiet small" onClick={() => onDownload("csv")}>
            Download CSV
          </button>
          <button className="btn btn-quiet small" onClick={() => onDownload("json")}>
            Download JSON
          </button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="tbl compare">
          <thead>
            <tr>
              <th>Retrieval</th>
              <th className="num">Improved</th>
              <th className="num">Baseline</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>
                  {r.label}
                  <span className="muted small-text">{r.hint}</span>
                </td>
                <td className={"num strong" + (r.better ? " good" : "")}>{r.improved}</td>
                <td className="num">{r.naive}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <section className="stats three" aria-label="Answer quality">
        <div className="stat">
          <span className="stat-value">{pct(summary.faithfulness)}</span>
          <span className="stat-label">Answers fully supported by their sources</span>
        </div>
        <div className="stat">
          <span className="stat-value">{pct(summary.correctness)}</span>
          <span className="stat-label">Answers matching the reference</span>
        </div>
        <div className="stat">
          <span className="stat-value">{(summary.avgLatencyMs / 1000).toFixed(1)}s</span>
          <span className="stat-label">Average time per answer</span>
        </div>
      </section>

      <div className="table-wrap top-gap">
        <table className="tbl per-q">
          <thead>
            <tr>
              <th>Question</th>
              <th className="num">Rank</th>
              <th className="num">Baseline</th>
              <th>Grade</th>
            </tr>
          </thead>
          <tbody>
            {summary.rows.map((r) => (
              <FragmentRow key={r.id} r={r} open={open === r.id} toggle={() => setOpen(open === r.id ? null : r.id)} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FragmentRow({ r, open, toggle }: { r: EvalResultRow; open: boolean; toggle: () => void }) {
  return (
    <>
      <tr className="clickable" onClick={toggle}>
        <td>
          <button className="linkish" aria-expanded={open} onClick={(e) => (e.stopPropagation(), toggle())}>
            {r.question}
          </button>
          <span className="muted small-text">
            {r.docName}, p. {r.page}
          </span>
        </td>
        <td className="num">{r.improved.rank ?? "–"}</td>
        <td className="num">
          {r.naive.rank ?? "–"}
          {r.naive.duplicatesInTopK > 0 && <span className="muted small-text">{r.naive.duplicatesInTopK} dup</span>}
        </td>
        <td>
          <span className={"pill" + (r.faithful ? " ok" : " bad")}>{r.faithful ? "Supported" : "Unsupported"}</span>{" "}
          <span className={"pill" + (r.correct ? " ok" : "")}>{r.correct ? "Correct" : "Off"}</span>
        </td>
      </tr>
      {open && (
        <tr className="detail">
          <td colSpan={4}>
            <p>
              <strong>Expected:</strong> {r.expectedAnswer}
            </p>
            <p>
              <strong>Answer:</strong> {r.answer}
            </p>
            <p className="muted small-text">
              Grader: {r.judgeNote} · Improved top 5: {r.improved.retrieved.map((x) => `p.${x.page}`).join(", ")} · Baseline top 5:{" "}
              {r.naive.retrieved.map((x) => `p.${x.page}${x.chunkId.endsWith("#dup") ? "*" : ""}`).join(", ")} (* = duplicate copy)
            </p>
          </td>
        </tr>
      )}
    </>
  );
}
