import "server-only";
import { GoogleGenAI, ThinkingLevel } from "@google/genai";
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
const errText = (e: unknown) => String((e as Error)?.message ?? e);
const isTimeout = (e: unknown) => /abort|timed? ?out|deadline/i.test(errText(e)) || (e as Error)?.name === "AbortError" || (e as Error)?.name === "TimeoutError";
const isRateLimit = (e: unknown) => /429|RESOURCE_EXHAUSTED|quota/i.test(errText(e));

/** Plain-language reason for a failed AI call, safe to show to users. */
export function aiErrorMessage(e: unknown): string {
  if (e instanceof AiNotConfiguredError) return e.message;
  if (isRateLimit(e)) return "The AI service's usage limit was reached. Wait a minute and try again.";
  if (isTimeout(e)) return "The AI service took too long to respond. Try again.";
  if (/API key|API_KEY_INVALID|PERMISSION_DENIED|401|403/i.test(errText(e))) {
    return "The Gemini API key was rejected. Check GEMINI_API_KEY in the Vercel settings.";
  }
  if (/not found|404|is not supported/i.test(errText(e))) {
    return `The model "${CHAT_MODEL}" isn't available for this key. Set GEMINI_CHAT_MODEL to another model.`;
  }
  return "The AI service returned an error. Try again in a minute.";
}

/** Retry rate-limit and transient server errors with short backoff. Timeouts are not retried. */
async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    const t0 = Date.now();
    try {
      return await fn();
    } catch (e) {
      last = e;
      console.error(`[gemini] ${label} failed after ${Date.now() - t0}ms (attempt ${i + 1}): ${errText(e).slice(0, 300)}`);
      const retriable = !isTimeout(e) && /429|RESOURCE_EXHAUSTED|503|UNAVAILABLE|500|INTERNAL|overloaded|fetch failed/i.test(errText(e));
      if (!retriable || i === tries - 1) break;
      await sleep([2500, 6000][i] ?? 6000);
    }
  }
  throw last;
}

/**
 * Reasoning is kept low: answers come from retrieved passages, so long "thinking" only adds
 * latency. If a model rejects the setting, it is dropped for the rest of the instance's life.
 */
let thinkingSupported = true;
function genConfig(extra: Record<string, unknown>, timeoutMs: number) {
  return {
    ...extra,
    abortSignal: AbortSignal.timeout(timeoutMs),
    ...(thinkingSupported ? { thinkingConfig: { thinkingLevel: ThinkingLevel.LOW } } : {}),
  };
}
async function withThinkingFallback<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (thinkingSupported && /thinking/i.test(errText(e))) {
      thinkingSupported = false;
      return await fn();
    }
    throw e;
  }
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
    const res = await withRetry("embed documents", () =>
      gemini().models.embedContent({
        model: EMBED_MODEL,
        contents: batch.map((t) => ({ parts: [{ text: t }] })),
        config: { outputDimensionality: EMBED_DIMS, abortSignal: AbortSignal.timeout(60_000) },
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
  const res = await withRetry("embed query", () =>
    gemini().models.embedContent({
      model: EMBED_MODEL,
      contents: [{ parts: [{ text: input }] }],
      config: { outputDimensionality: EMBED_DIMS, abortSignal: AbortSignal.timeout(15_000) },
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

/**
 * Streams an answer. The whole call (including streaming) is capped at `timeoutMs`
 * so a slow model fails with a clear message instead of hitting the platform timeout.
 */
export async function* streamAnswer(
  question: string,
  sources: { n: number; docName: string; locator: string; page: number; text: string }[],
  history: ChatTurn[] = [],
  timeoutMs = 40_000
): AsyncGenerator<string> {
  if (aiMode === "mock") {
    const text = mockAnswer(question, sources);
    for (const word of text.split(/(?<= )/)) yield word;
    return;
  }
  const t0 = Date.now();
  const stream = await withRetry("answer", () =>
    withThinkingFallback(() =>
      gemini().models.generateContentStream({
        model: CHAT_MODEL,
        contents: [{ role: "user", parts: [{ text: buildPrompt(question, sources, history) }] }],
        config: genConfig({ systemInstruction: SYSTEM, temperature: 0.2, maxOutputTokens: 4096 }, timeoutMs),
      })
    )
  );
  let chars = 0;
  for await (const chunk of stream) {
    if (chunk.text) {
      chars += chunk.text.length;
      yield chunk.text;
    }
  }
  if (!chars) throw new Error("The model returned an empty answer.");
  console.log(`[gemini] answer ok in ${Date.now() - t0}ms, ${chars} chars`);
}

export async function answerOnce(
  question: string,
  sources: { n: number; docName: string; locator: string; page: number; text: string }[]
): Promise<string> {
  let out = "";
  for await (const t of streamAnswer(question, sources)) out += t;
  return out.trim();
}

export async function generateJSON<T>(prompt: string, mock: () => T, timeoutMs = 45_000): Promise<T> {
  if (aiMode === "mock") return mock();
  const res = await withRetry("json", () =>
    withThinkingFallback(() =>
      gemini().models.generateContent({
        model: CHAT_MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        config: genConfig({ temperature: 0.2, responseMimeType: "application/json", maxOutputTokens: 8192 }, timeoutMs),
      })
    )
  );
  const raw = (res.text ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  return JSON.parse(raw) as T;
}
