import "server-only";
import { parseFile, detectKind } from "./parse";
import { chunkPages, stripBoilerplate } from "./chunk";
import { EMBED_DIMS, EMBED_MODEL, embedDocuments, embedMode } from "./ai";
import { termOverlap, tokenize } from "./bm25";
import { NEAR_DUP_TERMS } from "./retrieve";
import { loadIndex, saveIndex, withIndexLock } from "./index-store";
import { chunkHash, cosine, encodeVector, randomId, sha256 } from "./text";
import { deleteFile, writeFileBuf } from "./storage";
import type { ChunkRecord, DocRecord } from "./types";
import { pruneEvalForRemovedDocs } from "./eval";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export class DuplicateFileError extends Error {
  constructor(
    public existing: DocRecord,
    public match: "file" | "content" = "file"
  ) {
    super(
      match === "file"
        ? `This exact file is already in the library as "${existing.name}".`
        : `Every passage in this file is already indexed (it matches "${existing.name}"), so nothing new was added.`
    );
  }
}

export type IngestResult = {
  doc: DocRecord;
  replaced: boolean;
  chunksCreated: number;
  duplicateChunksSkipped: number;
  boilerplateLinesRemoved: number;
  /** Embeddings are configured but failed for this file, so it is keyword-searchable only. */
  keywordOnly: boolean;
};

/** Check by file fingerprint before uploading. */
export async function findBySha(hash: string) {
  const { data } = await loadIndex(true);
  return data.docs.find((d) => d.sha256 === hash) ?? null;
}

export async function ingestFile(opts: {
  buf: Buffer;
  name: string;
  replace?: boolean;
  /** Already stored at this path (client upload); otherwise stored here. */
  blobPathname?: string;
}): Promise<IngestResult> {
  const { buf, name } = opts;
  const kind = detectKind(name);
  if (!kind) throw new Error("Unsupported file type. Use PDF, Word (.docx), .txt or .md.");
  if (buf.length > MAX_FILE_BYTES) throw new Error("File is larger than 10 MB.");
  const fileHash = sha256(buf);

  // Parse and embed outside the lock (slow), then merge under the lock.
  const parsed = await parseFile(buf, name);
  const { pages, removed } = stripBoilerplate(parsed.pages);
  const raw = chunkPages(pages);
  if (!raw.length) throw new Error("No usable text was found in this file.");

  return withIndexLock(async () => {
    const loaded = await loadIndex(true);
    const { data } = loaded;

    // 1) File-level duplicate: same bytes already indexed (the class-notebook bug).
    const existing = data.docs.find((d) => d.sha256 === fileHash);
    let replaced = false;
    if (existing) {
      if (!opts.replace) {
        data.stats.duplicateFilesBlocked++;
        await saveIndex(data);
        throw new DuplicateFileError(existing);
      }
      data.chunks = data.chunks.filter((c) => c.docId !== existing.id);
      data.docs = data.docs.filter((d) => d.id !== existing.id);
      if (existing.blobPathname && existing.blobPathname !== opts.blobPathname) {
        await deleteFile(existing.blobPathname);
      }
      replaced = true;
    }

    // 2) Exact chunk duplicates: same normalized text already in the index or earlier in this file.
    const known = new Set(data.chunks.map((c) => c.hash));
    const docId = randomId("doc_");
    const fresh: Omit<ChunkRecord, "emb">[] = [];
    let skipped = 0;
    for (const rc of raw) {
      const h = chunkHash(rc.text);
      if (known.has(h)) {
        skipped++;
        continue;
      }
      known.add(h);
      fresh.push({
        id: randomId("c_"),
        docId,
        docName: name,
        page: rc.page,
        locator: parsed.locator,
        text: rc.text,
        hash: h,
      });
    }

    // 3) Near duplicates: almost the same vocabulary as an existing passage, or (when
    //    embeddings are available) almost the same meaning.
    const existingTerms = [...loaded.bm25.tf.values()];
    const vectors = await embedDocuments(fresh.map((c) => ({ title: name, text: c.text })));
    const pool: Float32Array[] = vectors ? [...loaded.vectors.values()] : [];
    const accepted: ChunkRecord[] = [];
    const acceptedTerms: Map<string, number>[] = [];
    fresh.forEach((c, i) => {
      const terms = termCounts(c.text);
      const sameWords =
        terms.size >= 8 &&
        (existingTerms.some((t) => termOverlap(t, terms) >= NEAR_DUP_TERMS) ||
          acceptedTerms.some((t) => termOverlap(t, terms) >= NEAR_DUP_TERMS));
      const v = vectors?.[i]?.length ? Float32Array.from(vectors[i]) : null;
      const sameMeaning = !!v && pool.some((p) => p.length === v.length && cosine(p, v) >= 0.985);
      if (sameWords || sameMeaning) {
        skipped++;
        return;
      }
      if (v) pool.push(v);
      acceptedTerms.push(terms);
      accepted.push({ ...c, ...(v ? { emb: encodeVector(v) } : {}) });
    });

    // A file whose every passage is already indexed (e.g. the same document re-saved) adds nothing.
    if (!accepted.length) {
      const firstHash = chunkHash(raw[0].text);
      const owner = data.chunks.find((c) => c.hash === firstHash);
      const ownerDoc = data.docs.find((d) => d.id === owner?.docId) ?? data.docs[0];
      data.stats.duplicateFilesBlocked++;
      data.stats.duplicateChunksSkipped += skipped;
      await saveIndex(data);
      if (ownerDoc) throw new DuplicateFileError(ownerDoc, "content");
      throw new Error("Every passage in this file is already indexed.");
    }

    let blobPathname = opts.blobPathname;
    if (!blobPathname) {
      blobPathname = `uploads/${fileHash.slice(0, 16)}-${name.replace(/[^\w.-]+/g, "_")}`;
      await writeFileBuf(blobPathname, buf, "application/octet-stream");
    }

    const doc: DocRecord = {
      id: docId,
      name,
      sha256: fileHash,
      size: buf.length,
      kind,
      pages: parsed.pages.length,
      chunkCount: accepted.length,
      duplicateChunksSkipped: skipped,
      boilerplateLinesRemoved: removed,
      uploadedAt: new Date().toISOString(),
      blobPathname,
      embeddedCount: accepted.filter((c) => c.emb).length,
    };
    data.docs.push(doc);
    data.chunks.push(...accepted);
    data.stats.duplicateChunksSkipped += skipped;
    await saveIndex(data);

    return {
      doc,
      replaced,
      chunksCreated: accepted.length,
      duplicateChunksSkipped: skipped,
      boilerplateLinesRemoved: removed,
      keywordOnly: embedMode !== "none" && accepted.some((c) => !c.emb),
    };
  });
}

function termCounts(text: string) {
  const m = new Map<string, number>();
  for (const t of tokenize(text)) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

/**
 * Adds embeddings to passages indexed for keyword search only (for example when the
 * embedding service was unavailable at upload, or GEMINI_API_KEY was added later).
 * Works in batches so each call stays within the time limit.
 */
export async function addMissingEmbeddings(limit = 150) {
  if (embedMode === "none") return { added: 0, remaining: 0, available: false };
  const { data: snapshot } = await loadIndex(true);
  const sameModel = snapshot.embedModel === EMBED_MODEL && snapshot.dims === EMBED_DIMS;
  const todo = snapshot.chunks.filter((c) => !sameModel || !c.emb).slice(0, limit);
  if (!todo.length) return { added: 0, remaining: 0, available: true };
  const vectors = await embedDocuments(todo.map((c) => ({ title: c.docName, text: c.text })));
  if (!vectors) throw new Error("The embedding service didn't respond. Search keeps working with keywords; try again later.");
  return withIndexLock(async () => {
    const { data } = await loadIndex(true);
    if (!sameModel) {
      // switching embedding model: old vectors can't be mixed with new ones
      for (const c of data.chunks) delete c.emb;
      data.embedModel = EMBED_MODEL;
      data.dims = EMBED_DIMS;
    }
    const byId = new Map(todo.map((c, i) => [c.id, vectors[i]]));
    let added = 0;
    for (const c of data.chunks) {
      const v = byId.get(c.id);
      if (v?.length) {
        c.emb = encodeVector(v);
        added++;
      }
    }
    for (const d of data.docs) d.embeddedCount = data.chunks.filter((c) => c.docId === d.id && c.emb).length;
    await saveIndex(data);
    return { added, remaining: data.chunks.filter((c) => !c.emb).length, available: true };
  });
}

/** Best-effort removal of stored originals; never blocks or fails the index update. */
async function deleteStoredFiles(paths: string[]) {
  await Promise.race([
    Promise.allSettled(paths.map((p) => deleteFile(p))),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
}

/** Removes documents by id (or all documents) from the index, then their stored files. */
export async function deleteDocs(ids: string[] | "all") {
  let removedChunkIds = new Set<string>();
  const removed = await withIndexLock(async () => {
    const { data } = await loadIndex(true);
    const drop = ids === "all" ? data.docs : data.docs.filter((d) => ids.includes(d.id));
    if (!drop.length) return [];
    const dropIds = new Set(drop.map((d) => d.id));
    const chunkIds = new Set(data.chunks.filter((c) => dropIds.has(c.docId)).map((c) => c.id));
    removedChunkIds = chunkIds;
    data.docs = data.docs.filter((d) => !dropIds.has(d.id));
    data.chunks = data.chunks.filter((c) => !dropIds.has(c.docId));
    await saveIndex(data);
    return drop;
  });
  if (removed.length) {
    await pruneEvalForRemovedDocs({ chunkIds: removedChunkIds, names: new Set(removed.map((d) => d.name)) }, ids === "all").catch((e) =>
      console.error("pruning evaluation data failed", e)
    );
  }
  const paths = removed.map((d) => d.blobPathname).filter((p): p is string => !!p);
  if (paths.length) await deleteStoredFiles(paths);
  return removed.length;
}
