import "server-only";
import { readJSON, writeJSON } from "./storage";
import { EMBED_DIMS, EMBED_MODEL } from "./ai";
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

type Loaded = { data: IndexData; vectors: Map<string, Float32Array>; at: number };
let cache: Loaded | null = null;
const MAX_AGE_MS = 20_000;

function hydrate(data: IndexData): Loaded {
  const vectors = new Map<string, Float32Array>();
  for (const c of data.chunks) vectors.set(c.id, decodeVector(c.emb));
  return { data, vectors, at: Date.now() };
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
