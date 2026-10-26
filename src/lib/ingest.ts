import "server-only";
import { parseFile, detectKind } from "./parse";
import { chunkPages, stripBoilerplate } from "./chunk";
import { embedDocuments } from "./ai";
import { loadIndex, saveIndex, withIndexLock } from "./index-store";
import { chunkHash, cosine, encodeVector, randomId, sha256 } from "./text";
import { deleteFile, writeFileBuf } from "./storage";
import type { ChunkRecord, DocRecord } from "./types";

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
    const { data, vectors: existingVecs } = await loadIndex(true);

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

    // 3) Near duplicates: embeddings almost identical to an existing chunk.
    const vectors = fresh.length
      ? await embedDocuments(fresh.map((c) => ({ title: name, text: c.text })))
      : [];
    const pool: Float32Array[] = data.chunks
      .map((c) => existingVecs.get(c.id))
      .filter((v): v is Float32Array => !!v);
    const accepted: ChunkRecord[] = [];
    fresh.forEach((c, i) => {
      const v = Float32Array.from(vectors[i]);
      if (pool.some((p) => cosine(p, v) >= 0.985)) {
        skipped++;
        return;
      }
      pool.push(v);
      accepted.push({ ...c, emb: encodeVector(v) });
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
    };
  });
}

export async function deleteDoc(id: string) {
  return withIndexLock(async () => {
    const { data } = await loadIndex(true);
    const doc = data.docs.find((d) => d.id === id);
    if (!doc) return false;
    data.docs = data.docs.filter((d) => d.id !== id);
    data.chunks = data.chunks.filter((c) => c.docId !== id);
    if (doc.blobPathname) await deleteFile(doc.blobPathname);
    await saveIndex(data);
    return true;
  });
}
