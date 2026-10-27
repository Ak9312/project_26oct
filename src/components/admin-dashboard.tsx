"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { upload } from "@vercel/blob/client";
import {
  ChevronDown,
  CircleCheck,
  Database,
  Download,
  ExternalLink,
  FileText,
  FlaskConical,
  Info,
  LoaderCircle,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert,
  Upload,
} from "lucide-react";
import { SiteHeader } from "./site-header";
import { docTitle } from "./answer";
import { Button } from "./ui/button";
import { Alert, Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/primitives";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Progress,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "./ui/radix";
import { cn } from "@/lib/utils";
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
      if (!r.ok && r.status !== 404) setLibError(data.error ?? "Couldn't remove the document. Try again.");
      else if (data.docs) setDocs({ docs: data.docs, chunkCount: data.chunkCount, stats: data.stats });
      else await refreshDocs();
    } catch {
      setLibError("Couldn't reach the server. Check your connection and try again.");
    } finally {
      setRemoving(null);
    }
  }

  const keywordOnly = docs && config && config.embedMode !== "none" ? docs.docs.reduce((a, d) => a + d.chunkCount - (d.embeddedCount ?? 0), 0) : 0;

  return (
    <div className="min-h-dvh bg-muted/40">
      <SiteHeader
        title="Policy Knowledge Assistant"
        tag="Admin"
        actions={
          <Button variant="onBrand" size="sm" asChild>
            <a href="/" target="_blank" rel="noreferrer">
              <ExternalLink />
              <span className="hidden sm:inline">Open public site</span>
              <span className="sm:hidden">Public site</span>
            </a>
          </Button>
        }
      />

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-8 sm:px-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Document administration</h1>
          <p className="mt-1.5 text-muted-foreground">Manage what the public assistant answers from, and measure how well it answers.</p>
        </div>

        {config && <StatusStrip config={config} />}

        <section aria-label="Library totals" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat icon={<FileText />} label="Documents" value={docs?.docs.length} />
          <Stat icon={<Database />} label="Passages indexed" value={docs?.chunkCount} />
          <Stat icon={<CircleCheck />} label="Duplicate uploads blocked" value={docs?.stats.duplicateFilesBlocked} tone="success" />
          <Stat icon={<CircleCheck />} label="Repeated passages skipped" value={docs?.stats.duplicateChunksSkipped} tone="success" />
        </section>

        <Tabs defaultValue="documents">
          <TabsList>
            <TabsTrigger value="documents">
              <FileText />
              Documents
            </TabsTrigger>
            <TabsTrigger value="evaluation">
              <FlaskConical />
              Evaluation
            </TabsTrigger>
          </TabsList>

          <TabsContent value="documents" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Upload documents</CardTitle>
                <CardDescription>
                  Each file is fingerprinted first, so the same document can&apos;t be indexed twice. Repeated headers, footers and passages
                  are removed before indexing.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div
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
                  className={cn(
                    "flex flex-col items-center justify-center gap-3 rounded-md border-2 border-dashed px-6 py-8 text-center transition-colors",
                    dragging ? "border-primary bg-info-soft" : "border-border bg-muted/50"
                  )}
                >
                  <Upload className="size-6 text-muted-foreground" aria-hidden />
                  <div>
                    <p className="font-semibold">Drop files here, or choose them</p>
                    <p className="text-sm text-muted-foreground">PDF, Word (.docx), .txt or .md, up to 10 MB each</p>
                  </div>
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
                  <Button onClick={() => fileInput.current?.click()} disabled={config?.aiMode === "missing"}>
                    Choose files
                  </Button>
                </div>

                {queue.length > 0 && (
                  <ul className="space-y-2">
                    {queue.map((it) => (
                      <UploadRow
                        key={it.key}
                        it={it}
                        onReplace={() => sendToIndex(it, true)}
                        onKeep={() => update(it.key, { state: "skipped", message: "Kept the existing copy." })}
                      />
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
                <div>
                  <CardTitle>Library</CardTitle>
                  <CardDescription>Documents published to the public assistant.</CardDescription>
                </div>
                {docs && docs.docs.length > 1 && (
                  <ConfirmRemove
                    title={`Remove all ${docs.docs.length} documents?`}
                    body="Every document, its passages and its test questions are removed from the library. The public assistant will have nothing to answer from."
                    confirm="Remove all"
                    onConfirm={() => removeDocs("all")}
                  >
                    <Button variant="outline" size="sm" className="text-destructive" disabled={!!removing}>
                      {removing === "all" ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
                      Remove all
                    </Button>
                  </ConfirmRemove>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                {libError && (
                  <Alert variant="destructive">
                    <TriangleAlert />
                    <div>{libError}</div>
                  </Alert>
                )}
                {keywordOnly > 0 && <EmbedBackfill onDone={refreshDocs} missing={keywordOnly} />}
                {!docs ? (
                  <p className="text-sm text-muted-foreground">Loading…</p>
                ) : docs.docs.length === 0 ? (
                  <div className="rounded-md border border-dashed px-6 py-10 text-center">
                    <p className="font-semibold">Add your first document</p>
                    <p className="mt-1 text-sm text-muted-foreground">It appears in the public assistant as soon as it&apos;s indexed.</p>
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Document</TableHead>
                        <TableHead className="text-right">Pages</TableHead>
                        <TableHead className="text-right">Passages</TableHead>
                        <TableHead className="text-right">Repeats skipped</TableHead>
                        <TableHead>Added</TableHead>
                        <TableHead>
                          <span className="sr-only">Actions</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {docs.docs.map((d) => (
                        <TableRow key={d.id}>
                          <TableCell className="min-w-56">
                            <div className="font-semibold break-words">{docTitle(d.name)}</div>
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                              <span>{fmtSize(d.size)}</span>
                              <span>Fingerprint {d.sha256.slice(0, 10)}</span>
                              {config?.embedMode !== "none" && (d.embeddedCount ?? 0) < d.chunkCount && (
                                <Badge variant="warning">Keyword search only</Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="tabular text-right">{d.pages}</TableCell>
                          <TableCell className="tabular text-right">{d.chunkCount}</TableCell>
                          <TableCell className="tabular text-right">{d.duplicateChunksSkipped}</TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">{fmtDate(d.uploadedAt)}</TableCell>
                          <TableCell className="text-right">
                            <ConfirmRemove
                              title={`Remove “${docTitle(d.name)}”?`}
                              body={`Its ${d.chunkCount} passage${d.chunkCount === 1 ? "" : "s"} and any test questions written from it are removed. This can't be undone.`}
                              confirm="Remove document"
                              onConfirm={() => removeDocs(d)}
                            >
                              <Button variant="ghost" size="sm" className="text-destructive" disabled={!!removing} aria-label={`Remove ${d.name}`}>
                                {removing === d.id ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
                                Remove
                              </Button>
                            </ConfirmRemove>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="evaluation" forceMount className="data-[state=inactive]:hidden">
            <Evaluation hasDocs={(docs?.chunkCount ?? 0) > 0} aiReady={config?.aiMode !== "missing"} />
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}

function StatusStrip({ config }: { config: Config }) {
  const items = [
    {
      ok: config.aiMode === "groq",
      warn: config.aiMode !== "groq",
      label: "Answers",
      value:
        config.aiMode === "groq"
          ? `Groq ${config.chatModel.replace("openai/", "")}`
          : config.aiMode === "mock"
            ? "Offline test mode, answers aren't real"
            : "GROQ_API_KEY missing, chat is off",
    },
    {
      ok: config.aiMode === "groq",
      warn: config.aiMode !== "groq",
      label: "Testing and grading",
      value: config.aiMode === "groq" ? `Groq ${config.evalModel.replace("openai/", "")}` : "Unavailable",
    },
    {
      ok: config.embedMode !== "none",
      warn: false,
      label: "Search",
      value: config.embedMode === "gemini" ? "Keywords and meaning" : config.embedMode === "mock" ? "Keywords and mock meaning" : "Keywords only",
    },
    { ok: true, warn: false, label: "Storage", value: config.storageMode === "blob" ? "Private Vercel Blob" : "Local folder" },
  ];
  return (
    <Card>
      <dl className="grid divide-y sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-4 lg:divide-x">
        {items.map((it) => (
          <div key={it.label} className="flex items-start gap-2.5 px-5 py-3.5">
            {it.warn ? (
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            ) : it.ok ? (
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            ) : (
              <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <div className="min-w-0">
              <dt className="text-xs font-semibold text-muted-foreground">{it.label}</dt>
              <dd className="text-sm font-semibold break-words">{it.value}</dd>
            </div>
          </div>
        ))}
      </dl>
    </Card>
  );
}

function Stat({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value?: number; tone?: "success" }) {
  return (
    <Card className="px-5 py-4">
      <div className={cn("flex items-center gap-2 text-sm text-muted-foreground [&_svg]:size-4", tone === "success" && "[&_svg]:text-success")}>
        {icon}
        {label}
      </div>
      <div className="tabular mt-1.5 text-3xl font-bold tracking-tight">{value ?? "–"}</div>
    </Card>
  );
}

function UploadRow({ it, onReplace, onKeep }: { it: QueueItem; onReplace: () => void; onKeep: () => void }) {
  const status = {
    hashing: { text: "Checking for duplicates", variant: "secondary" as const },
    uploading: { text: `Uploading ${Math.round(it.progress ?? 0)}%`, variant: "secondary" as const },
    indexing: { text: "Reading and indexing", variant: "secondary" as const },
    done: { text: "Indexed", variant: "success" as const },
    duplicate: { text: "Duplicate blocked", variant: "warning" as const },
    skipped: { text: "Skipped", variant: "secondary" as const },
    error: { text: "Failed", variant: "destructive" as const },
  }[it.state];
  const busy = it.state === "hashing" || it.state === "uploading" || it.state === "indexing";
  return (
    <li
      className={cn(
        "rounded-md border border-l-4 px-4 py-3",
        it.state === "done" && "border-l-success",
        it.state === "duplicate" && "border-l-warning bg-warning-soft/60",
        it.state === "error" && "border-l-destructive bg-destructive-soft/60",
        (busy || it.state === "skipped") && "border-l-border"
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2 font-semibold">
          {busy ? <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" aria-hidden /> : <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
          <span className="break-all">{it.file.name}</span>
        </span>
        <Badge variant={status.variant}>{status.text}</Badge>
      </div>
      {it.message && <p className="mt-1.5 text-sm text-muted-foreground">{it.message}</p>}
      {it.state === "duplicate" && it.existing && it.match === "file" && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">
            Uploaded {fmtDate(it.existing.uploadedAt)} as “{it.existing.name}”.
          </span>
          <Button variant="outline" size="sm" onClick={onReplace}>
            Replace existing
          </Button>
          <Button variant="ghost" size="sm" onClick={onKeep}>
            Keep existing
          </Button>
        </div>
      )}
    </li>
  );
}

function ConfirmRemove({
  title,
  body,
  confirm,
  onConfirm,
  children,
}: {
  title: string;
  body: string;
  confirm: string;
  onConfirm: () => void;
  children: React.ReactNode;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{body}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{confirm}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
    <Alert variant="warning" role="status" className="flex-wrap items-center">
      <Search />
      <div className="flex-1">
        {missing} passage{missing === 1 ? " is" : "s are"} searchable by keywords only. {msg}
      </div>
      <Button variant="outline" size="sm" onClick={go} disabled={busy}>
        {busy ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
        {busy ? "Adding" : "Add meaning search"}
      </Button>
    </Alert>
  );
}

// ---------------------------------------------------------------- evaluation

function Evaluation({ hasDocs, aiReady }: { hasDocs: boolean; aiReady: boolean }) {
  const [set, setSet] = useState<EvalQuestionSet | null>(null);
  const [summary, setSummary] = useState<EvalSummary | null>(null);
  const [building, setBuilding] = useState(false);
  const [run, setRun] = useState<{ done: number; total: number; rows: EvalResultRow[]; failed: number; waiting?: number } | null>(null);
  const [error, setError] = useState("");

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
    if (r.ok) setSet(data.set);
    else setError(data.error ?? "Couldn't build the test set.");
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
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Evaluation</CardTitle>
          <CardDescription className="max-w-[78ch]">
            A test set of up to 25 questions, each written from one specific indexed passage, so the right page is known. The run compares the improved
            search with the class-notebook baseline (every file indexed twice, plain top 5), then grades each answer.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={build} disabled={building || !!run || !hasDocs || !aiReady}>
              {building && <LoaderCircle className="animate-spin" />}
              {building ? "Writing questions" : set ? "Rebuild test set" : "Build 25 test questions"}
            </Button>
            <Button onClick={runAll} disabled={!set || !!run || building || !aiReady}>
              {run && <LoaderCircle className="animate-spin" />}
              {run ? (run.waiting ? `Groq limit, resuming in ${run.waiting}s` : `Running ${Math.min(run.done + 1, run.total)} of ${run.total}`) : "Run evaluation"}
            </Button>
          </div>
          {!hasDocs && <p className="text-sm text-muted-foreground">Upload documents first; questions are written from them.</p>}
          {run && <Progress value={(run.done / run.total) * 100} aria-label="Evaluation progress" />}
          {error && (
            <Alert variant="warning">
              <TriangleAlert />
              <div>{error}</div>
            </Alert>
          )}
          {set && (
            <details className="group rounded-md border">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-semibold">
                <span>
                  {set.questions.length} test questions
                  <span className="ml-2 font-normal text-muted-foreground">Built {fmtDate(set.createdAt)}</span>
                </span>
                <ChevronDown className="size-4 transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <div className="border-t px-4 py-3">
                <p className="mb-3 text-xs text-muted-foreground">{set.method}</p>
                <ol className="list-decimal space-y-2 pl-5 text-sm marker:text-muted-foreground">
                  {set.questions.map((q) => (
                    <li key={q.id}>
                      {q.question}
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        {docTitle(q.docName)}, page {q.page}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            </details>
          )}
        </CardContent>
      </Card>

      {summary && <Results summary={summary} onDownload={download} />}
    </div>
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
      hint: "1.00 means the right page was always ranked first",
      improved: summary.improved.mrr.toFixed(2),
      naive: summary.naive.mrr.toFixed(2),
      better: summary.improved.mrr >= summary.naive.mrr,
    },
    {
      label: "Duplicate results in top 5",
      hint: "Result slots wasted on a copy of another result",
      improved: pct(summary.improved.duplicateRate),
      naive: pct(summary.naive.duplicateRate),
      better: summary.improved.duplicateRate <= summary.naive.duplicateRate,
    },
  ];
  const search = summary.searchMode === "hybrid" ? "Keyword and meaning search" : summary.searchMode === "keyword" ? "Keyword search" : summary.searchMode ? "Mixed search" : null;
  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle>Latest results</CardTitle>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <Badge variant="secondary">{fmtDate(summary.runAt)}</Badge>
            <Badge variant="secondary">{summary.total} questions</Badge>
            <Badge variant="secondary">
              {summary.aiMode === "mock" ? "Offline test mode" : `Answers by ${summary.chatModel.replace("openai/", "")}`}
            </Badge>
            {summary.judgeModel && summary.aiMode !== "mock" && <Badge variant="secondary">Graded by {summary.judgeModel.replace("openai/", "")}</Badge>}
            {search && <Badge variant="secondary">{search}</Badge>}
          </div>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => onDownload("csv")}>
            <Download />
            CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => onDownload("json")}>
            <Download />
            JSON
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Retrieval measure</TableHead>
              <TableHead className="text-right">Improved</TableHead>
              <TableHead className="text-right">Baseline</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.label}>
                <TableCell>
                  <div className="font-semibold">{r.label}</div>
                  <div className="text-xs text-muted-foreground">{r.hint}</div>
                </TableCell>
                <TableCell className={cn("tabular text-right text-lg font-bold", r.better && "text-success")}>{r.improved}</TableCell>
                <TableCell className="tabular text-right text-lg text-muted-foreground">{r.naive}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <div className="grid gap-3 sm:grid-cols-3">
          {[
            [pct(summary.faithfulness), "Answers fully supported by their sources"],
            [pct(summary.correctness), "Answers matching the reference"],
            [`${(summary.avgLatencyMs / 1000).toFixed(1)}s`, "Average time per answer"],
          ].map(([v, l]) => (
            <div key={l} className="rounded-md bg-muted px-4 py-3">
              <div className="tabular text-2xl font-bold">{v}</div>
              <div className="text-sm text-muted-foreground">{l}</div>
            </div>
          ))}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-bold">Per question</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Question</TableHead>
                <TableHead className="text-right">Rank</TableHead>
                <TableHead className="text-right">Baseline</TableHead>
                <TableHead>Grade</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {summary.rows.map((r) => (
                <QuestionRow key={r.id} r={r} open={open === r.id} toggle={() => setOpen(open === r.id ? null : r.id)} />
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

function QuestionRow({ r, open, toggle }: { r: EvalResultRow; open: boolean; toggle: () => void }) {
  return (
    <>
      <TableRow data-state={open ? "open" : "closed"}>
        <TableCell className="min-w-64">
          <button className="text-left font-medium hover:underline focus-visible:outline-[3px] focus-visible:outline-ring" aria-expanded={open} onClick={toggle}>
            {r.question}
          </button>
          <div className="text-xs text-muted-foreground">
            {docTitle(r.docName)}, page {r.page}
          </div>
        </TableCell>
        <TableCell className="tabular text-right">{r.improved.rank ?? "–"}</TableCell>
        <TableCell className="tabular text-right">
          {r.naive.rank ?? "–"}
          {r.naive.duplicatesInTopK > 0 && <div className="text-xs text-muted-foreground">{r.naive.duplicatesInTopK} duplicates</div>}
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap gap-1">
            <Badge variant={r.faithful ? "success" : "destructive"}>{r.faithful ? "Supported" : "Unsupported"}</Badge>
            <Badge variant={r.correct ? "success" : "secondary"}>{r.correct ? "Correct" : "Not matching"}</Badge>
          </div>
        </TableCell>
      </TableRow>
      {open && (
        <TableRow className="bg-muted/60 hover:bg-muted/60">
          <TableCell colSpan={4} className="space-y-2 text-sm">
            <p>
              <span className="font-semibold">Expected:</span> {r.expectedAnswer}
            </p>
            <p>
              <span className="font-semibold">Answer:</span> {r.answer}
            </p>
            <p className="text-xs text-muted-foreground">
              Grader: {r.judgeNote} Improved top 5: {r.improved.retrieved.map((x) => `p.${x.page}`).join(", ")}. Baseline top 5:{" "}
              {r.naive.retrieved.map((x) => `p.${x.page}${x.chunkId.endsWith("#dup") ? "*" : ""}`).join(", ")} (* duplicate copy).
            </p>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}
