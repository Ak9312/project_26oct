import "server-only";
import { bm25Scores, termOverlap } from "./bm25";
import type { Loaded } from "./index-store";
import { cosine } from "./text";
import type { ChunkRecord } from "./types";

export type Scored = { chunk: ChunkRecord; score: number };

/** Two results this similar in meaning are treated as the same passage. */
export const NEAR_DUP = 0.95;
/** Two results sharing this much vocabulary are treated as the same passage. */
export const NEAR_DUP_TERMS = 0.9;

const RRF_K = 60;
const POOL = 60;

export type SearchMode = "hybrid" | "keyword";

/**
 * Ranks every passage for a question.
 * - Keyword ranking (BM25) always runs.
 * - When every passage has an embedding and the question could be embedded, meaning-based
 *   ranking runs too, and the two lists are merged with reciprocal rank fusion.
 */
export function rankChunks(loaded: Loaded, question: string, queryVec: number[] | null): { ranked: Scored[]; mode: SearchMode } {
  const byId = new Map(loaded.data.chunks.map((c) => [c.id, c]));
  const kw = [...bm25Scores(loaded.bm25, question)].sort((a, b) => b[1] - a[1]).slice(0, POOL);

  const useVectors = !!queryVec && loaded.vectorsComplete && queryVec.length === loaded.vectors.values().next().value?.length;
  if (!useVectors) {
    return { ranked: kw.map(([id, s]) => ({ chunk: byId.get(id)!, score: s })), mode: "keyword" };
  }

  const q = Float32Array.from(queryVec!);
  const sem: [string, number][] = [];
  for (const [id, v] of loaded.vectors) sem.push([id, cosine(q, v)]);
  sem.sort((a, b) => b[1] - a[1]);

  const fused = new Map<string, number>();
  kw.forEach(([id], i) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
  sem.slice(0, POOL).forEach(([id], i) => fused.set(id, (fused.get(id) ?? 0) + 1 / (RRF_K + i + 1)));
  const ranked = [...fused]
    .sort((a, b) => b[1] - a[1])
    .map(([id, s]) => ({ chunk: byId.get(id)!, score: s }));
  return { ranked, mode: "hybrid" };
}

function isNearDuplicate(loaded: Loaded, a: ChunkRecord, b: ChunkRecord) {
  if (a.hash === b.hash) return true;
  const va = loaded.vectors.get(a.id);
  const vb = loaded.vectors.get(b.id);
  if (va && vb && cosine(va, vb) >= NEAR_DUP) return true;
  return termOverlap(loaded.bm25.tf.get(a.id), loaded.bm25.tf.get(b.id)) >= NEAR_DUP_TERMS;
}

/** Improved retrieval: the top-k *distinct* passages from a ranked list. */
export function retrieveUnique(loaded: Loaded, ranked: Scored[], k = 5): Scored[] {
  const picked: Scored[] = [];
  for (const cand of ranked) {
    if (picked.length >= k) break;
    if (picked.some((p) => isNearDuplicate(loaded, p.chunk, cand.chunk))) continue;
    picked.push(cand);
  }
  return picked;
}

/**
 * Baseline from the class notebook: every file indexed twice, plain top-k.
 * Each passage therefore appears twice in a row in the ranking.
 */
export function retrieveNaive(ranked: Scored[], k = 5): Scored[] {
  return ranked.flatMap((r) => [r, { chunk: { ...r.chunk, id: r.chunk.id + "#dup" }, score: r.score }]).slice(0, k);
}

/** Number of results in a list that repeat an earlier result's text. */
export function countDuplicates(results: Scored[]) {
  const seen = new Set<string>();
  let d = 0;
  for (const r of results) {
    if (seen.has(r.chunk.hash)) d++;
    seen.add(r.chunk.hash);
  }
  return d;
}
