"use client";

import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";

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

export const docTitle = (name: string) => name.replace(/\.(pdf|docx|txt|md)$/i, "").replace(/[_]+/g, " ");

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
          aria-label={`Show source ${n}`}
          className="mx-0.5 inline-flex h-[1.35em] min-w-[1.35em] -translate-y-px items-center justify-center rounded-[4px] border border-primary/40 px-1 align-middle text-[0.72em] font-bold leading-none text-primary transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:outline-[3px] focus-visible:outline-ring"
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

/** Paragraphs, bullet and numbered lists, bold, and clickable citations. */
export function AnswerText({ text, onCite, streaming }: { text: string; onCite: (n: number) => void; streaming?: boolean }) {
  const blocks = text.trim().split(/\n{2,}/);
  return (
    <div className={cn("space-y-4 text-[17px] leading-[1.7] text-foreground", streaming && "streaming-caret")}>
      {blocks.map((block, bi) => {
        const lines = block.split("\n").filter((l) => l.trim());
        const isList = lines.length > 0 && lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l));
        if (isList) {
          const ordered = /^\s*\d/.test(lines[0]);
          const items = lines.map((l, li) => <li key={li}>{inline(l.replace(/^\s*([-*•]|\d+[.)])\s+/, ""), onCite, `${bi}-${li}-`)}</li>);
          return ordered ? (
            <ol key={bi} className="list-decimal space-y-1.5 pl-6 marker:font-semibold">
              {items}
            </ol>
          ) : (
            <ul key={bi} className="list-disc space-y-1.5 pl-6">
              {items}
            </ul>
          );
        }
        return (
          <p key={bi} className="max-w-[68ch]">
            {inline(lines.join(" "), onCite, `${bi}-`)}
          </p>
        );
      })}
    </div>
  );
}

function bestSentence(sentences: string[], answer: string) {
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
  return best;
}

/**
 * Highlights the sentence in a source that shares the most words with the answer.
 * With `excerpt`, shows only the highlighted sentence and its neighbours, so the
 * evidence is visible without expanding the card.
 */
export function HighlightedPassage({
  text,
  answer,
  excerpt = false,
  className,
}: {
  text: string;
  answer: string;
  excerpt?: boolean;
  className?: string;
}) {
  const sentences = text.split(/(?<=[.!?;])\s+/);
  const best = answer ? bestSentence(sentences, answer) : -1;
  let from = 0;
  let to = sentences.length;
  if (excerpt && best >= 0) {
    from = Math.max(0, best - 1);
    to = Math.min(sentences.length, best + 2);
  }
  const shown = sentences.slice(from, to);
  return (
    <p className={className}>
      {from > 0 && "… "}
      {shown.map((s, j) => {
        const i = from + j;
        return (
          <Fragment key={i}>
            {i === best ? <mark className="mark-cite">{s}</mark> : s}
            {j < shown.length - 1 ? " " : ""}
          </Fragment>
        );
      })}
      {to < sentences.length && " …"}
    </p>
  );
}
