import "server-only";
import { GoogleGenAI } from "@google/genai";
import { normalizeForHash } from "./text";

export const EMBED_DIMS = 768;
export const CHAT_MODEL = process.env.GEMINI_CHAT_MODEL || "gemini-3.8-flash";
export const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-2";

/**
 * "gemini" when GEMINI_API_KEY is set. "mock" is an offline stand-in used only for
 * local development and tests (MOCK_AI=1); it is never used in production.
 */
export const aiMode: "gemini" | "mock" | "missing" = process.env.GEMINI_API_KEY
  ? "gemini"
  : process.env.MOCK_AI === "1"
    ? "mock"
    : "missing";

export class AiNotConfiguredError extends Error {
  constructor() {
    super("The assistant isn't configured yet: GEMINI_API_KEY is missing on the server.");
  }
}

let client: GoogleGenAI | null = null;
function gemini() {
  if (aiMode !== "gemini") throw new AiNotConfiguredError();
  if (!client) client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry rate-limit and transient server errors with backoff. */
async function withRetry<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = String((e as Error)?.message ?? e);
      const retriable = /429|RESOURCE_EXHAUSTED|503|UNAVAILABLE|500|INTERNAL|overloaded|fetch failed/i.test(msg);
      if (!retriable || i === tries - 1) break;
      await sleep([2000, 6000, 15000][i] ?? 15000);
    }
  }
  throw last;
}

// ---------- mock provider (local tests only) ----------

function mockEmbed(text: string): number[] {
  const v = new Float32Array(EMBED_DIMS);
  const words = normalizeForHash(text).split(" ").filter((w) => w.length > 2);
  const feats = [...words, ...words.slice(1).map((w, i) => words[i] + "_" + w)];
  for (const f of feats) {
    let h = 2166136261;
    for (let i = 0; i < f.length; i++) h = Math.imul(h ^ f.charCodeAt(i), 16777619);
    v[Math.abs(h) % EMBED_DIMS] += h & 1 ? 1 : -1;
  }
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => x / n);
}

// ---------- embeddings ----------

export async function embedDocuments(items: { title: string; text: string }[]): Promise<number[][]> {
  const inputs = items.map((it) => `title: ${it.title} | text: ${it.text}`);
  if (aiMode === "mock") return inputs.map(mockEmbed);
  const out: number[][] = [];
  const BATCH = 50;
  for (let i = 0; i < inputs.length; i += BATCH) {
    const batch = inputs.slice(i, i + BATCH);
    const res = await withRetry(() =>
      gemini().models.embedContent({
        model: EMBED_MODEL,
        contents: batch.map((t) => ({ parts: [{ text: t }] })),
        config: { outputDimensionality: EMBED_DIMS },
      })
    );
    const embs = res.embeddings ?? [];
    if (embs.length !== batch.length) {
      throw new Error(`Embedding service returned ${embs.length} vectors for ${batch.length} chunks.`);
    }
    for (const e of embs) out.push(e.values ?? []);
  }
  return out;
}

export async function embedQuery(q: string): Promise<number[]> {
  const input = `task: question answering | query: ${q}`;
  if (aiMode === "mock") return mockEmbed(input);
  const res = await withRetry(() =>
    gemini().models.embedContent({
      model: EMBED_MODEL,
      contents: [{ parts: [{ text: input }] }],
      config: { outputDimensionality: EMBED_DIMS },
    })
  );
  return res.embeddings?.[0]?.values ?? [];
}

// ---------- generation ----------

export type ChatTurn = { role: "user" | "assistant"; text: string };

export const NOT_FOUND = "I couldn't find this in the published documents.";

const SYSTEM = `You answer questions about public policy documents.
Rules:
- Use ONLY the numbered sources provided. Never use outside knowledge, even if you know the answer.
- Cite every factual sentence with the source number in square brackets, like [1] or [2][3].
- If the sources do not contain the answer, reply exactly: "${NOT_FOUND}" and nothing else.
- Be concise and plain: short paragraphs or a short list. Quote exact figures, dates and names as written in the sources.
- Do not mention "sources" or "context" by name in prose; just cite with brackets.`;

function buildPrompt(question: string, sources: { n: number; docName: string; locator: string; page: number; text: string }[], history: ChatTurn[]) {
  const ctx = sources
    .map((s) => `[${s.n}] ${s.docName}, ${s.locator} ${s.page}\n${s.text}`)
    .join("\n\n");
  const hist = history
    .slice(-4)
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text.slice(0, 600)}`)
    .join("\n");
  return `${hist ? `Earlier conversation (for context only):\n${hist}\n\n` : ""}Sources:\n${ctx}\n\nQuestion: ${question}`;
}

function mockAnswer(question: string, sources: { n: number; text: string }[]) {
  if (!sources.length) return NOT_FOUND;
  const qWords = new Set(normalizeForHash(question).split(" ").filter((w) => w.length > 3));
  const picks: string[] = [];
  for (const s of sources.slice(0, 3)) {
    const sentence = s.text
      .split(/(?<=[.!?])\s+/)
      .map((t) => ({ t, score: normalizeForHash(t).split(" ").filter((w) => qWords.has(w)).length }))
      .sort((a, b) => b.score - a.score)[0];
    if (sentence && sentence.score > 0) picks.push(`${sentence.t.trim()} [${s.n}]`);
  }
  return picks.length ? picks.join("\n\n") : NOT_FOUND;
}

export async function* streamAnswer(
  question: string,
  sources: { n: number; docName: string; locator: string; page: number; text: string }[],
  history: ChatTurn[] = []
): AsyncGenerator<string> {
  if (aiMode === "mock") {
    const text = mockAnswer(question, sources);
    for (const word of text.split(/(?<= )/)) yield word;
    return;
  }
  const stream = await withRetry(() =>
    gemini().models.generateContentStream({
      model: CHAT_MODEL,
      contents: [{ role: "user", parts: [{ text: buildPrompt(question, sources, history) }] }],
      config: { systemInstruction: SYSTEM, temperature: 0.2, maxOutputTokens: 1200 },
    })
  );
  for await (const chunk of stream) {
    if (chunk.text) yield chunk.text;
  }
}

export async function answerOnce(
  question: string,
  sources: { n: number; docName: string; locator: string; page: number; text: string }[]
): Promise<string> {
  let out = "";
  for await (const t of streamAnswer(question, sources)) out += t;
  return out.trim();
}

export async function generateJSON<T>(prompt: string, mock: () => T): Promise<T> {
  if (aiMode === "mock") return mock();
  const res = await withRetry(() =>
    gemini().models.generateContent({
      model: CHAT_MODEL,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: { temperature: 0.2, responseMimeType: "application/json" },
    })
  );
  const raw = (res.text ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  return JSON.parse(raw) as T;
}
