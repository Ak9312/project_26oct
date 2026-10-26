import "server-only";
import { promises as fs } from "fs";
import path from "path";
import { put, get, del } from "@vercel/blob";

/**
 * Storage backend.
 * - On Vercel (BLOB_READ_WRITE_TOKEN set): a private Vercel Blob store.
 * - Locally: files under ./.data so the app runs without any cloud setup.
 */
export const storageMode: "blob" | "local" = process.env.BLOB_READ_WRITE_TOKEN
  ? "blob"
  : "local";

const LOCAL_ROOT = path.join(process.cwd(), ".data");

function localPath(p: string) {
  const resolved = path.join(LOCAL_ROOT, p);
  if (!resolved.startsWith(LOCAL_ROOT)) throw new Error("Invalid path");
  return resolved;
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function readFileBuf(p: string): Promise<Buffer | null> {
  if (storageMode === "local") {
    try {
      return await fs.readFile(localPath(p));
    } catch {
      return null;
    }
  }
  try {
    const res = await get(p, { access: "private", useCache: false });
    if (!res || res.statusCode !== 200) return null;
    return await streamToBuffer(res.stream);
  } catch (e) {
    if (e instanceof Error && /not found/i.test(e.message)) return null;
    throw e;
  }
}

export async function writeFileBuf(p: string, data: Buffer | string, contentType: string) {
  if (storageMode === "local") {
    const lp = localPath(p);
    await fs.mkdir(path.dirname(lp), { recursive: true });
    await fs.writeFile(lp, data);
    return;
  }
  await put(p, data, {
    access: "private",
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType,
  });
}

export async function deleteFile(p: string) {
  if (storageMode === "local") {
    await fs.rm(localPath(p), { force: true });
    return;
  }
  try {
    await del(p);
  } catch {
    /* already gone */
  }
}

export async function readJSON<T>(p: string): Promise<T | null> {
  const buf = await readFileBuf(p);
  if (!buf) return null;
  return JSON.parse(buf.toString("utf8")) as T;
}

export async function writeJSON(p: string, data: unknown) {
  await writeFileBuf(p, JSON.stringify(data), "application/json");
}
