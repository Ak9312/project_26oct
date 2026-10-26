import "server-only";
import { cosine } from "./text";
import type { ChunkRecord } from "./types";

export type Scored = { chunk: ChunkRecord; score: number };

/** Two results this similar are treated as the same passage. */
export const NEAR_DUP = 0.95;

function rank(query: Float32Array, chunks: ChunkRecord[], vectors: Map<string, Float32Array>): Scored[] {
  const out: Scored[] = [];
  for (const c of chunks) {
    const v = vectors.get(c.id);
    if (v) out.push({ chunk: c, score: cosine(query, v) });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Improved retrieval: top-k distinct passages. A candidate is skipped when its text hash
 * matches an already selected result or its embedding is near-identical to one.
 */
export function retrieveUnique(
  query: Float32Array,
  chunks: ChunkRecord[],
  vectors: Map<string, Float32Array>,
  k = 5
): Scored[] {
  const ranked = rank(query, chunks, vectors);
  const picked: Scored[] = [];
  const hashes = new Set<string>();
  for (const cand of ranked) {
    if (picked.length >= k) break;
    if (hashes.has(cand.chunk.hash)) continue;
    const cv = vectors.get(cand.chunk.id)!;
    if (picked.some((p) => cosine(cv, vectors.get(p.chunk.id)!) >= NEAR_DUP)) continue;
    picked.push(cand);
    hashes.add(cand.chunk.hash);
  }
  return picked;
}

/** Baseline retrieval as in the class notebook: plain top-k, no duplicate handling. */
export function retrieveNaive(
  query: Float32Array,
  chunks: ChunkRecord[],
  vectors: Map<string, Float32Array>,
  k = 5
): Scored[] {
  return rank(query, chunks, vectors).slice(0, k);
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
