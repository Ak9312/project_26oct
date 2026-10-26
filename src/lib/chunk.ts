import { normalizeForHash } from "./text";

export type RawChunk = { page: number; text: string };

/**
 * Remove lines that repeat on many pages (running headers, footers, page numbers).
 * These otherwise produce near-identical chunks across a document.
 */
export function stripBoilerplate(pages: string[]): { pages: string[]; removed: number } {
  const pageLines = pages.map((p) => p.split(/\n/));
  const keyOf = (line: string) => normalizeForHash(line).replace(/\d+/g, "#");
  const boiler = new Set<string>();
  if (pages.length >= 4) {
    const counts = new Map<string, number>();
    for (const lines of pageLines) {
      const seen = new Set<string>();
      for (const line of lines) {
        const key = keyOf(line);
        if (!key || key.length > 120 || seen.has(key)) continue;
        seen.add(key);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const threshold = Math.max(3, Math.ceil(pages.length * 0.5));
    for (const [k, c] of counts) if (c >= threshold) boiler.add(k);
  }
  // a bare page number ("12", "Page 12 of 40") is always boilerplate
  const pageNum = /^\s*(page\s*)?\d+(\s*(of|\/)\s*\d+)?\s*$/i;
  let removed = 0;
  const cleaned = pageLines.map((lines) =>
    lines
      .filter((line) => {
        const key = keyOf(line);
        const drop = (key && boiler.has(key)) || pageNum.test(line);
        if (drop) removed++;
        return !drop;
      })
      .join("\n")
  );
  return { pages: cleaned, removed };
}

export function splitSentences(text: string): string[] {
  const clean = text.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  if (!clean) return [];
  const parts = clean
    .split(/(?<=[.!?;])\s+(?=[A-Z0-9(“"'ऀ-ॿ])|\n(?=\s*(?:[-•*]|\d+(?:\.\d+)*[.)]?|\(?[a-z]\))\s)/)
    .map((s) => s.replace(/\n/g, " ").trim())
    .filter(Boolean);
  // hard-wrap sentences that are still too long (tables, run-on lists)
  const out: string[] = [];
  for (const s of parts) {
    if (s.length <= 1200) out.push(s);
    else for (let i = 0; i < s.length; i += 1000) out.push(s.slice(i, i + 1000));
  }
  return out;
}

/**
 * Page-aware chunking. Chunks never cross a page boundary, so every chunk
 * can be cited with an exact page number. Neighbouring chunks share at most one
 * short sentence of overlap, small enough that it cannot create near-duplicate chunks.
 */
export function chunkPages(pages: string[], target = 900, minLen = 220): RawChunk[] {
  const chunks: RawChunk[] = [];
  pages.forEach((pageText, i) => {
    const page = i + 1;
    let cur: string[] = [];
    let overlap = 0; // how many leading sentences of `cur` repeat the previous chunk
    let len = 0;
    for (const s of splitSentences(pageText)) {
      if (len + s.length > target && len > minLen) {
        chunks.push({ page, text: cur.join(" ") });
        const last = cur[cur.length - 1];
        cur = last.length < 250 ? [last] : [];
        overlap = cur.length;
        len = cur.reduce((a, x) => a + x.length + 1, 0);
      }
      cur.push(s);
      len += s.length + 1;
    }
    const fresh = cur.slice(overlap);
    if (!fresh.length) return;
    const prev = chunks[chunks.length - 1];
    const freshText = fresh.join(" ");
    if (freshText.length < minLen && prev && prev.page === page) {
      prev.text = prev.text + " " + freshText;
    } else {
      chunks.push({ page, text: cur.join(" ") });
    }
  });
  return chunks.filter((c) => normalizeForHash(c.text).replace(/\s/g, "").length >= 40);
}
