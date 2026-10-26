"use client";

import { Fragment, type ReactNode } from "react";

export type UiSource = {
  n: number;
  chunkId: string;
  docName: string;
  page: number;
  locator: "Page" | "Section";
  text: string;
  score: number;
};

/** Citation numbers actually used in an answer, in order of first use. */
export function citedNumbers(answer: string): number[] {
  const out: number[] = [];
  for (const m of answer.matchAll(/\[(\d+)\]/g)) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function inline(text: string, onCite: (n: number) => void, key: string): ReactNode[] {
  const parts = text.split(/(\[\d+\]|\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    const cite = p.match(/^\[(\d+)\]$/);
    if (cite) {
      const n = Number(cite[1]);
      return (
        <button
          key={key + i}
          type="button"
          onClick={() => onCite(n)}
          className="cite-chip"
          aria-label={`Show source ${n}`}
        >
          {n}
        </button>
      );
    }
    const bold = p.match(/^\*\*([^*]+)\*\*$/);
    if (bold) return <strong key={key + i}>{bold[1]}</strong>;
    return <Fragment key={key + i}>{p}</Fragment>;
  });
}

/** Minimal renderer: paragraphs, bullet and numbered lists, bold, and clickable citations. */
export function AnswerText({ text, onCite, streaming }: { text: string; onCite: (n: number) => void; streaming?: boolean }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className={"answer read" + (streaming ? " caret-last" : "")}>
      {blocks.map((block, bi) => {
        const lines = block.split("\n").filter((l) => l.trim());
        const isList = lines.length > 0 && lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l));
        if (isList) {
          const ordered = /^\s*\d/.test(lines[0]);
          const items = lines.map((l, li) => (
            <li key={li}>{inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ""), onCite, `${bi}-${li}-`)}</li>
          ));
          return ordered ? <ol key={bi}>{items}</ol> : <ul key={bi}>{items}</ul>;
        }
        return <p key={bi}>{inline(lines.join(" "), onCite, `${bi}-`)}</p>;
      })}
    </div>
  );
}

/** Highlights the sentence in a source that shares the most words with the answer. */
export function HighlightedPassage({ text, answer }: { text: string; answer: string }) {
  const sentences = text.split(/(?<=[.!?;])\s+/);
  const answerWords = new Set(
    answer
      .toLowerCase()
      .replace(/\[\d+\]/g, "")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 3)
  );
  let best = -1;
  let bestScore = 2;
  sentences.forEach((s, i) => {
    const words = s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 3);
    const score = words.filter((w) => answerWords.has(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return (
    <p className="read passage">
      {sentences.map((s, i) => (
        <Fragment key={i}>
          {i === best ? <mark className="cite-mark">{s}</mark> : s}
          {i < sentences.length - 1 ? " " : ""}
        </Fragment>
      ))}
    </p>
  );
}
