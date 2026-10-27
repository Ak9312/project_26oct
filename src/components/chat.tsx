"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUp, BookOpen, FileText, LoaderCircle, SquarePen, TriangleAlert } from "lucide-react";
import { AnswerText, citedNumbers, docTitle, HighlightedPassage, type UiSource } from "./answer";
import { DemoBanner, SiteHeader } from "./site-header";
import { Button } from "./ui/button";
import { Alert, Badge, Card, CardContent, CardHeader, CardTitle, Textarea } from "./ui/primitives";
import { cn } from "@/lib/utils";

const REPO_URL = "https://github.com/Ak9312/project_26oct";

type Library = { documents: { name: string; pages: number; kind: string }[]; chunkCount: number; suggestions: string[] };

type Msg =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; text: string; sources: UiSource[]; status: "streaming" | "done" | "error"; error?: string };

const NOT_FOUND_PREFIX = "I couldn't find this";

export default function Chat() {
  const [library, setLibrary] = useState<Library | null>(null);
  const [libraryError, setLibraryError] = useState(false);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [inputError, setInputError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch("/api/library")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setLibrary)
      .catch(() => setLibraryError(true));
  }, []);

  useEffect(() => {
    if (msgs.length) endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q) {
      setInputError("Enter a question first.");
      inputRef.current?.focus();
      return;
    }
    if (busy) return;
    setInputError("");
    setInput("");
    setBusy(true);
    const history = msgs
      .filter((m) => m.role === "user" || m.status === "done")
      .slice(-4)
      .map((m) => ({ role: m.role, text: m.text }));
    const aid = crypto.randomUUID();
    setMsgs((m) => [
      ...m,
      { id: crypto.randomUUID(), role: "user", text: q },
      { id: aid, role: "assistant", text: "", sources: [], status: "streaming" },
    ]);
    const patch = (fn: (m: Extract<Msg, { role: "assistant" }>) => Partial<Extract<Msg, { role: "assistant" }>>) =>
      setMsgs((all) => all.map((m) => (m.id === aid && m.role === "assistant" ? { ...m, ...fn(m) } : m)));

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({ error: "Something went wrong. Try again." }));
        patch(() => ({ status: "error", error: err.error }));
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "sources") patch(() => ({ sources: ev.sources }));
          else if (ev.type === "delta") patch((m) => ({ text: m.text + ev.text }));
          else if (ev.type === "done") patch(() => ({ status: "done" }));
          else if (ev.type === "error") patch(() => ({ status: "error", error: ev.error }));
        }
      }
      patch((m) => (m.status === "streaming" ? { status: "done" } : {}));
    } catch {
      patch(() => ({ status: "error", error: "Couldn't reach the server. Check your connection and try again." }));
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  const empty = msgs.length === 0;
  const docs = library?.documents ?? [];
  const composer = (
    <QuestionForm
      big={empty}
      value={input}
      busy={busy}
      error={inputError}
      inputRef={inputRef}
      onChange={(v) => {
        setInput(v);
        if (inputError) setInputError("");
      }}
      onSubmit={() => ask(input)}
    />
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <SiteHeader
        title="Policy Knowledge Assistant"
        actions={
          !empty && (
            <Button variant="onBrand" size="sm" onClick={() => setMsgs([])} aria-label="New question">
              <SquarePen />
              <span className="hidden sm:inline">New question</span>
            </Button>
          )
        }
      />
      <DemoBanner />

      {empty ? (
        <main className="mx-auto grid w-full max-w-6xl flex-1 gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-14 lg:py-14">
          <section>
            <h1 className="max-w-[18ch] text-4xl font-bold leading-[1.1] tracking-tight sm:text-[44px]">Ask a question about public policy</h1>
            <p className="mt-4 max-w-[56ch] text-lg leading-relaxed text-muted-foreground">
              Answers are written only from the documents in the library, and every statement links to the page it came from.
            </p>
            <div className="mt-8 max-w-2xl">{composer}</div>

            {library && library.suggestions.length > 0 && (
              <div className="mt-10 max-w-2xl">
                <h2 className="text-base font-semibold">Example questions</h2>
                <ul className="mt-3 divide-y border-y">
                  {library.suggestions.map((s) => (
                    <li key={s}>
                      <button
                        onClick={() => ask(s)}
                        disabled={busy}
                        className="w-full py-3 text-left text-[15px] text-link underline decoration-1 underline-offset-4 hover:decoration-2 focus-visible:outline-[3px] focus-visible:outline-ring"
                      >
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <aside className="space-y-6">
            <Card>
              <CardHeader className="flex-row items-center gap-2">
                <BookOpen className="size-5 text-muted-foreground" aria-hidden />
                <CardTitle className="text-base">Documents in the library</CardTitle>
              </CardHeader>
              <CardContent className="pt-3">
                {libraryError && <p className="text-sm text-muted-foreground">The document list couldn&apos;t be loaded. Questions still work.</p>}
                {!library && !libraryError && <p className="text-sm text-muted-foreground">Loading documents…</p>}
                {library && docs.length === 0 && <p className="text-sm text-muted-foreground">No documents have been published yet.</p>}
                {docs.length > 0 && (
                  <ul className="divide-y">
                    {docs.map((d) => (
                      <li key={d.name} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                        <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 flex-1 text-sm font-medium leading-snug break-words">{docTitle(d.name)}</span>
                        <span className="tabular shrink-0 text-xs text-muted-foreground">
                          {d.pages} {d.kind === "pdf" ? (d.pages === 1 ? "page" : "pages") : d.pages === 1 ? "section" : "sections"}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">How answers are produced</CardTitle>
              </CardHeader>
              <CardContent className="pt-3">
                <ol className="space-y-3 text-sm">
                  {[
                    ["Search", "The library is searched for the passages most relevant to your question."],
                    ["Answer", "An answer is written using only those passages, never outside knowledge."],
                    ["Cite", "Each statement links to its source page so you can check it."],
                  ].map(([t, d], i) => (
                    <li key={t} className="flex gap-3">
                      <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-xs font-bold text-secondary-foreground tabular">
                        {i + 1}
                      </span>
                      <span>
                        <span className="font-semibold">{t}.</span> <span className="text-muted-foreground">{d}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              </CardContent>
            </Card>
          </aside>
        </main>
      ) : (
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-6 sm:px-6" aria-live="polite">
          {msgs.map((m, i) =>
            m.role === "user" ? (
              <h2 key={m.id} className={cn("text-2xl font-bold leading-snug tracking-tight", i === 0 ? "mt-8" : "mt-12 border-t pt-10")}>
                {m.text}
              </h2>
            ) : (
              <AssistantTurn key={m.id} msg={m} />
            )
          )}
          <div ref={endRef} />
        </main>
      )}

      {!empty && <div className="sticky bottom-0 z-10 border-t bg-background/95 backdrop-blur">{<div className="mx-auto max-w-6xl px-4 py-3 sm:px-6">{composer}</div>}</div>}

      {empty && (
        <footer className="border-t">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:justify-between sm:px-6">
            <p>Answers can contain mistakes. Always check the cited page before relying on an answer.</p>
            <a href={REPO_URL} className="text-link underline underline-offset-4" target="_blank" rel="noreferrer">
              Source code and method
            </a>
          </div>
        </footer>
      )}
    </div>
  );
}

function QuestionForm({
  big,
  value,
  busy,
  error,
  inputRef,
  onChange,
  onSubmit,
}: {
  big: boolean;
  value: string;
  busy: boolean;
  error: string;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <label htmlFor="q" className={big ? "mb-2 block text-base font-semibold" : "sr-only"}>
        Your question
      </label>
      <div className="flex items-end gap-2">
        <Textarea
          id="q"
          ref={inputRef}
          rows={1}
          maxLength={600}
          placeholder="For example: what are the targets for school enrolment?"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          aria-invalid={!!error}
          aria-describedby={error ? "q-err" : undefined}
          className={cn("resize-none [field-sizing:content] border-2 border-input", big ? "min-h-14 max-h-48 py-3.5 text-[17px]" : "min-h-11 max-h-40")}
        />
        <Button type="submit" size={big ? "lg" : "default"} disabled={busy} className={big ? "h-14" : "h-11"}>
          {busy ? <LoaderCircle className="animate-spin" /> : <ArrowUp />}
          {busy ? "Answering" : "Ask"}
        </Button>
      </div>
      {error && (
        <p id="q-err" className="mt-2 text-sm font-semibold text-destructive">
          {error}
        </p>
      )}
      {!big && <p className="mt-2 text-xs text-muted-foreground">Answers can contain mistakes. Check the cited page.</p>}
    </form>
  );
}

function AssistantTurn({ msg }: { msg: Extract<Msg, { role: "assistant" }> }) {
  const [showAll, setShowAll] = useState(false);
  const [focus, setFocus] = useState<number | null>(null);
  const refs = useRef<Record<number, HTMLElement | null>>({});

  const done = msg.status === "done";
  const notFound = done && msg.text.trim().startsWith(NOT_FOUND_PREFIX);
  const cited = citedNumbers(msg.text);
  const citedSources = cited.map((n) => msg.sources.find((s) => s.n === n)).filter(Boolean) as UiSource[];
  const others = msg.sources.filter((s) => !cited.includes(s.n));
  const visible = notFound ? msg.sources.slice(0, 3) : showAll || citedSources.length === 0 ? [...citedSources, ...others] : citedSources;

  function onCite(n: number) {
    if (!cited.includes(n)) setShowAll(true);
    setFocus(n);
    setTimeout(() => refs.current[n]?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 30);
    setTimeout(() => setFocus(null), 1800);
  }

  return (
    <article className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-10">
      <div className="min-w-0">
        {msg.status === "error" ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <div>{msg.error}</div>
          </Alert>
        ) : msg.text ? (
          <AnswerText text={msg.text} onCite={onCite} streaming={msg.status === "streaming"} />
        ) : (
          <p className="flex items-center gap-2 text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
            Searching the documents…
          </p>
        )}
      </div>

      {done && msg.sources.length > 0 && (
        <aside aria-label="Sources" className="lg:sticky lg:top-4 lg:self-start">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-bold">
              {notFound ? "Closest passages found" : `Source${citedSources.length === 1 ? "" : "s"}`}
            </h3>
            {!notFound && others.length > 0 && citedSources.length > 0 && (
              <Button variant="link" size="sm" className="text-[13px]" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show cited only" : `Show all ${msg.sources.length} searched`}
              </Button>
            )}
          </div>
          <div className="space-y-3">
            {visible.map((s) => (
              <SourceCard
                key={s.chunkId}
                s={s}
                answer={notFound ? "" : msg.text}
                cited={cited.includes(s.n)}
                focused={focus === s.n}
                refCb={(el) => {
                  refs.current[s.n] = el;
                }}
              />
            ))}
          </div>
        </aside>
      )}
    </article>
  );
}

function SourceCard({
  s,
  answer,
  cited,
  focused,
  refCb,
}: {
  s: UiSource;
  answer: string;
  cited: boolean;
  focused: boolean;
  refCb: (el: HTMLElement | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const long = s.text.length > 380;
  return (
    <figure
      ref={refCb}
      className={cn(
        "scroll-mt-24 rounded-md border bg-card transition-shadow",
        cited ? "border-l-4 border-l-primary" : "border-l-4 border-l-border",
        focused && "ring-[3px] ring-ring"
      )}
    >
      <figcaption className="flex items-start gap-2.5 border-b px-3.5 py-2.5">
        <span
          className={cn(
            "mt-px flex size-5 shrink-0 items-center justify-center rounded-[4px] text-[11px] font-bold tabular",
            cited ? "bg-primary text-primary-foreground" : "bg-secondary text-secondary-foreground"
          )}
        >
          {s.n}
        </span>
        <span className="min-w-0 flex-1 text-sm font-semibold leading-snug break-words">{docTitle(s.docName)}</span>
        <Badge variant="secondary" className="tabular">
          {s.locator} {s.page}
        </Badge>
      </figcaption>
      <div className="px-3.5 py-3">
        <HighlightedPassage
          text={s.text}
          answer={answer}
          excerpt={long && !open}
          className={cn("text-sm leading-relaxed text-muted-foreground", long && !open && "line-clamp-6")}
        />
        {long && (
          <Button variant="link" size="sm" className="mt-1.5 text-[13px]" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? "Show less" : "Read full passage"}
          </Button>
        )}
      </div>
    </figure>
  );
}
