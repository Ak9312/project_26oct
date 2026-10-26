"use client";

import { useEffect, useRef, useState } from "react";
import { AnswerText, citedNumbers, HighlightedPassage, type UiSource } from "./answer";
import { Seal } from "./seal";

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
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [msgs]);

  async function ask(question: string) {
    const q = question.trim();
    if (!q) {
      setInputError("Type a question first.");
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

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <Seal />
          <span>Policy Knowledge Assistant</span>
        </div>
        {!empty && (
          <button className="btn btn-quiet" onClick={() => setMsgs([])}>
            New question
          </button>
        )}
      </header>

      <main className="thread" aria-live="polite">
        {empty && (
          <section className="intro">
            <h1 className="read intro-title">Ask what the policy actually says.</h1>
            <p className="intro-sub">
              Answers come only from the published documents below, and every answer shows the page it was taken from.
            </p>

            {library && library.suggestions.length > 0 && (
              <div className="suggest">
                <p className="label">Try one of these</p>
                {library.suggestions.map((s) => (
                  <button key={s} className="suggest-item" onClick={() => ask(s)} disabled={busy}>
                    {s}
                  </button>
                ))}
              </div>
            )}

            <div className="shelf">
              <p className="label">In the library</p>
              {libraryError && <p className="muted">The document list couldn&apos;t be loaded. Questions still work.</p>}
              {!library && !libraryError && <p className="muted">Loading documents…</p>}
              {library && docs.length === 0 && (
                <p className="muted">No documents have been published yet. Check back soon.</p>
              )}
              {docs.length > 0 && (
                <ul className="shelf-list">
                  {docs.map((d) => (
                    <li key={d.name}>
                      <span className="spine" aria-hidden="true" />
                      <span className="shelf-name">{d.name.replace(/\.(pdf|docx|txt|md)$/i, "")}</span>
                      <span className="shelf-meta">
                        {d.pages} {d.kind === "pdf" ? (d.pages === 1 ? "page" : "pages") : d.pages === 1 ? "section" : "sections"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}

        {msgs.map((m) =>
          m.role === "user" ? (
            <h2 key={m.id} className="q">
              {m.text}
            </h2>
          ) : (
            <AssistantTurn key={m.id} msg={m} />
          )
        )}
        <div ref={endRef} />
      </main>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <div className="composer-inner">
          <label htmlFor="q" className="sr-only">
            Your question
          </label>
          <textarea
            id="q"
            ref={inputRef}
            className="field composer-field"
            rows={1}
            maxLength={600}
            placeholder="Ask a question about the published policies"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (inputError) setInputError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                ask(input);
              }
            }}
            aria-invalid={!!inputError}
            aria-describedby={inputError ? "q-err" : undefined}
          />
          <button type="submit" className="btn btn-seal" disabled={busy}>
            {busy ? "Answering…" : "Ask"}
          </button>
        </div>
        {inputError && (
          <p id="q-err" className="field-error">
            {inputError}
          </p>
        )}
        <p className="fineprint">Answers are generated from the documents and can contain mistakes. Check the cited page.</p>
      </form>
    </div>
  );
}

function AssistantTurn({ msg }: { msg: Extract<Msg, { role: "assistant" }> }) {
  const [showAll, setShowAll] = useState(false);
  const [focus, setFocus] = useState<number | null>(null);
  const refs = useRef<Record<number, HTMLElement | null>>({});

  const notFound = msg.status === "done" && msg.text.trim().startsWith(NOT_FOUND_PREFIX);
  const cited = citedNumbers(msg.text);
  const citedSources = cited.map((n) => msg.sources.find((s) => s.n === n)).filter(Boolean) as UiSource[];
  const others = msg.sources.filter((s) => !cited.includes(s.n));
  const visible = showAll || citedSources.length === 0 ? [...citedSources, ...others] : citedSources;

  function onCite(n: number) {
    if (!cited.includes(n)) setShowAll(true);
    setFocus(n);
    setTimeout(() => refs.current[n]?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 30);
    setTimeout(() => setFocus(null), 1600);
  }

  return (
    <article className="turn">
      {msg.status === "error" ? (
        <div className="notice notice-danger" role="alert">
          {msg.error}
        </div>
      ) : msg.text ? (
        <AnswerText text={msg.text} onCite={onCite} streaming={msg.status === "streaming"} />
      ) : (
        <p className="muted searching">Searching the documents…</p>
      )}

      {msg.status === "done" && msg.sources.length > 0 && (
        <section className="sources" aria-label="Sources">
          <div className="sources-head">
            <p className="label">
              {notFound ? "Closest passages found" : citedSources.length === 1 ? "Source" : "Sources"}
            </p>
            {!notFound && others.length > 0 && citedSources.length > 0 && (
              <button className="btn btn-quiet small" onClick={() => setShowAll((v) => !v)}>
                {showAll ? "Show cited only" : `Show all ${msg.sources.length} passages searched`}
              </button>
            )}
          </div>
          <div className="source-list">
            {(notFound ? msg.sources.slice(0, 3) : visible).map((s) => (
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
        </section>
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
  const long = s.text.length > 420;
  return (
    <figure ref={refCb} className={"source" + (focused ? " is-focused" : "") + (cited ? "" : " is-uncited")}>
      <div className="source-tab">
        <span className="source-n">{s.n}</span>
        {s.locator === "Page" ? "p." : "§"} {s.page}
      </div>
      <div className="source-body">
        <figcaption className="source-doc">{s.docName}</figcaption>
        <div className={long && !open ? "clamp" : ""}>
          <HighlightedPassage text={s.text} answer={answer} />
        </div>
        {long && (
          <button className="btn btn-quiet small more" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? "Show less" : "Read full passage"}
          </button>
        )}
      </div>
    </figure>
  );
}
