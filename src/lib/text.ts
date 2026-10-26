import { createHash } from "crypto";

export function sha256(data: Buffer | string) {
  return createHash("sha256").update(data).digest("hex");
}

/** Normalization used for duplicate detection: case, spacing and punctuation are ignored. */
export function normalizeForHash(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function chunkHash(text: string) {
  return sha256(normalizeForHash(text));
}

export function encodeVector(v: number[] | Float32Array) {
  const f = v instanceof Float32Array ? v : Float32Array.from(v);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength).toString("base64");
}

export function decodeVector(b64: string) {
  const buf = Buffer.from(b64, "base64");
  const copy = new Uint8Array(buf.length);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

export function cosine(a: Float32Array, b: Float32Array) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function randomId(prefix = "") {
  return prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
