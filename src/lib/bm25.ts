/**
 * Keyword search (BM25). Needs no API key, so search keeps working even when
 * no embedding service is configured or it is temporarily unavailable.
 */

const STOP = new Set(
  (
    "a an and are as at be been being but by can could did do does for from had has have he her his how i if in into is it its " +
    "may me might more most must my no not of on or our out over shall she should so such than that the their them then there " +
    "these they this those through to under up upon us was we were what when where which while who whom why will with would you your " +
    "about above after again all also am any because before below between both during each few further here just once only other own " +
    "same some too very per via within without"
  ).split(" ")
);

/** Light English stemming so "targets"/"target" and "policies"/"policy" match. */
function stem(w: string) {
  if (w.length <= 4 || /\d/.test(w)) return w;
  if (w.endsWith("ies") && w.length > 5) return w.slice(0, -3) + "y";
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ing") && w.length > 6) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 5) return w.slice(0, -2);
  if (w.endsWith("es") && /(ch|sh|x|z|s)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

export type Bm25Index = {
  tf: Map<string, Map<string, number>>;
  len: Map<string, number>;
  df: Map<string, number>;
  avgdl: number;
  n: number;
};

export function buildBm25(items: { id: string; text: string }[]): Bm25Index {
  const tf = new Map<string, Map<string, number>>();
  const len = new Map<string, number>();
  const df = new Map<string, number>();
  let total = 0;
  for (const it of items) {
    const toks = tokenize(it.text);
    const m = new Map<string, number>();
    for (const t of toks) m.set(t, (m.get(t) ?? 0) + 1);
    tf.set(it.id, m);
    len.set(it.id, toks.length);
    total += toks.length;
    for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  return { tf, len, df, avgdl: items.length ? total / items.length : 0, n: items.length };
}

/** BM25 score for every passage that shares at least one term with the query. */
export function bm25Scores(idx: Bm25Index, query: string, k1 = 1.4, b = 0.75): Map<string, number> {
  const terms = [...new Set(tokenize(query))];
  const out = new Map<string, number>();
  if (!terms.length || !idx.n) return out;
  for (const t of terms) {
    const df = idx.df.get(t);
    if (!df) continue;
    const idf = Math.log(1 + (idx.n - df + 0.5) / (df + 0.5));
    for (const [id, m] of idx.tf) {
      const f = m.get(t);
      if (!f) continue;
      const dl = idx.len.get(id) ?? 0;
      const s = (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * dl) / (idx.avgdl || 1)));
      out.set(id, (out.get(id) ?? 0) + s);
    }
  }
  return out;
}

/** Share of distinct terms two passages have in common (1 = same vocabulary). */
export function termOverlap(a: Map<string, number> | undefined, b: Map<string, number> | undefined) {
  if (!a || !b || !a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const k of small.keys()) if (big.has(k)) inter++;
  return inter / (a.size + b.size - inter);
}
