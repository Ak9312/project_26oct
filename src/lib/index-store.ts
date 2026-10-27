import "server-only";
import { readJSON, writeJSON } from "./storage";
import { EMBED_DIMS, EMBED_MODEL } from "./ai";
import { buildBm25, type Bm25Index } from "./bm25";
import { decodeVector } from "./text";
import type { IndexData } from "./types";

const INDEX_PATH = "index/index.json";

export function emptyIndex(): IndexData {
  return {
    version: 1,
    embedModel: EMBED_MODEL,
    dims: EMBED_DIMS,
    docs: [],
    chunks: [],
    stats: { duplicateFilesBlocked: 0, duplicateChunksSkipped: 0 },
    updatedAt: new Date().toISOString(),
  };
}

export type Loaded = {
  data: IndexData;
  /** Embeddings by passage id (only passages that have one). */
  vectors: Map<string, Float32Array>;
  /** True when every passage has a compatible embedding, so meaning-based ranking is fair to all documents. */
  vectorsComplete: boolean;
  bm25: Bm25Index;
  at: number;
};
let cache: Loaded | null = null;
const MAX_AGE_MS = 20_000;

function hydrate(data: IndexData): Loaded {
  const vectors = new Map<string, Float32Array>();
  const compatible = data.embedModel === EMBED_MODEL && data.dims === EMBED_DIMS;
  if (compatible) {
    for (const c of data.chunks) {
      if (!c.emb) continue;
      const v = decodeVector(c.emb);
      if (v.length === EMBED_DIMS) vectors.set(c.id, v);
    }
  }
  // the document name is searchable too, so "water policy" finds the water policy
  const bm25 = buildBm25(data.chunks.map((c) => ({ id: c.id, text: `${c.docName.replace(/\.[a-z]+$/i, "")} ${c.text}` })));
  return {
    data,
    vectors,
    vectorsComplete: data.chunks.length > 0 && vectors.size === data.chunks.length,
    bm25,
    at: Date.now(),
  };
}

/** Index for reading (chat). Cached briefly per server instance. */
export async function loadIndex(fresh = false): Promise<Loaded> {
  if (!fresh && cache && Date.now() - cache.at < MAX_AGE_MS) return cache;
  const data = (await readJSON<IndexData>(INDEX_PATH)) ?? emptyIndex();
  cache = hydrate(data);
  return cache;
}

export async function saveIndex(data: IndexData) {
  data.updatedAt = new Date().toISOString();
  await writeJSON(INDEX_PATH, data);
  cache = hydrate(data);
}

/** Serialize admin writes within one server instance. */
let queue: Promise<unknown> = Promise.resolve();
export function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}
