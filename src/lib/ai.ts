import "server-only";
import Groq from "groq-sdk";
import { GoogleGenAI } from "@google/genai";
import { normalizeForHash } from "./text";

/**
 * Text generation: Groq (GROQ_API_KEY). Required.
 *   - Answers use GROQ_CHAT_MODEL.
 *   - Writing test questions and grading use GROQ_EVAL_MODEL. Groq's free limits are
 *     per model, so using a second model keeps evaluation from eating the chat budget.
 * Meaning-based search: Gemini embeddings (GEMINI_API_KEY). Optional. Groq has no
 *   embedding models; without this key the app uses keyword search only.
 * MOCK_AI=1 is an offline stand-in for local tests only.
 */
export const CHAT_MODEL = process.env.GROQ_CHAT_MODEL || "openai/gpt-oss-120b";
export const CHAT_FALLBACK_MODEL = process.env.GROQ_FALLBACK_MODEL || "openai/gpt-oss-20b";
export const EVAL_MODEL = process.env.GROQ_EVAL_MODEL || "openai/gpt-oss-20b";
export const EMBED_MODEL = process.env.GEMINI_EMBED_MODEL || "gemini-embedding-2";
export const EMBED_DIMS = 768;

const MOCK = process.env.MOCK_AI === "1";
export const aiMode: "groq" | "mock" | "missing" = process.env.GROQ_API_KEY ? "groq" : MOCK ? "mock" : "missing";
export const embedMode: "gemini" | "mock" | "none" = process.env.GEMINI_API_KEY ? "gemini" : MOCK ? "mock" : "none";

const isGptOss = (m: string) => m.startsWith("openai/gpt-oss");

export class AiNotConfiguredError extends Error {
  constructor() {
    super("The assistant isn't configured yet: GROQ_API_KEY is missing on the server.");
  }
}

/** Groq refused because a free-tier limit was reached. */
export class AiRateLimitError extends Error {
  constructor(
    public kind: "minute" | "day",
    public retryAfterS: number,
    public model: string
  ) {
    super(
      kind === "day"
        ? `Groq's daily free limit for ${model} is used up. It resets within 24 hours${retryAfterS ? ` (about ${fmtWait(retryAfterS)})` : ""}.`
        : `The assistant is busy (Groq's per-minute limit). Try again in ${Math.max(1, Math.round(retryAfterS))} seconds.`
    );
  }
}

function fmtWait(s: number) {
  if (s < 90) return `${Math.round(s)} seconds`;
  if (s < 5400) return `${Math.round(s / 60)} minutes`;
  return `${Math.round(s / 3600)} hours`;
}

let groqClient: Groq | null = null;
function groq() {
  if (aiMode !== "groq") throw new AiNotConfiguredError();
  // retries are handled below so rate-limit waits respect the route's time limit
  if (!groqClient) groqClient = new Groq({ apiKey: process.env.GROQ_API_KEY, maxRetries: 0 });
  return groqClient;
}

let geminiClient: GoogleGenAI | null = null;
function gemini() {
  if (!geminiClient) geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return geminiClient;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const errText = (e: unknown) => String((e as Error)?.message ?? e);
const errStatus = (e: unknown) => (e as { status?: number })?.status;
const isTimeout = (e: unknown) =>
  /abort|timed? ?out|deadline/i.test(errText(e)) ||
  ["AbortError", "TimeoutError", "APIConnectionTimeoutError"].includes((e as Error)?.name);

/** Turn a Groq 429 into a typed error with how long to wait. */
function asRateLimit(e: unknown, model: string): AiRateLimitError | null {
  if (errStatus(e) !== 429 && !/rate.?limit/i.test(errText(e))) return null;
  const headers = (e as { headers?: Headers }).headers;
  let wait = Number(headers?.get?.("retry-after") ?? NaN);
  const m = errText(e).match(/try again in ((\d+)h)?((\d+)m)?((\d+(?:\.\d+)?)s)?/i);
  if (m && (m[2] || m[4] || m[6])) wait = Number(m[2] ?? 0) * 3600 + Number(m[4] ?? 0) * 60 + Number(m[6] ?? 0);
  const perDay = /per day|\(RPD\)|\(TPD\)|daily/i.test(errText(e)) || wait > 600;
  return new AiRateLimitError(perDay ? "day" : "minute", Number.isFinite(wait) ? wait : 0, model);
}

/** Plain-language reason for a failed AI call, safe to show to users. */
export function aiErrorMessage(e: unknown): string {
  if (e instanceof AiNotConfiguredError || e instanceof AiRateLimitError) return e.message;
  if (isTimeout(e)) return "The AI service took too long to respond. Try again.";
  const status = errStatus(e);
  if (status === 401 || /invalid api key|invalid_api_key/i.test(errText(e))) {
    return "The Groq API key was rejected. Check GROQ_API_KEY in the Vercel settings.";
  }
  if (status === 404 || /model_not_found|does not exist|decommissioned/i.test(errText(e))) {
    return `A Groq model isn't available (${CHAT_MODEL} / ${EVAL_MODEL}). Set GROQ_CHAT_MODEL or GROQ_EVAL_MODEL to a current model.`;
  }
  return "The AI service returned an error. Try again in a minute.";
}

/**
 * Retries transient errors. Per-minute rate limits are waited out when the wait fits within
 * `maxWaitS`; otherwise (or for daily limits) an AiRateLimitError is thrown.
 */
async function withRetry<T>(label: string, model: string, fn: () => Promise<T>, maxWaitS = 8, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    const t0 = Date.now();
    try {
      return await fn();
    } catch (e) {
      console.error(`[groq] ${label} (${model}) failed after ${Date.now() - t0}ms, attempt ${i + 1}: ${errText(e).slice(0, 300)}`);
      const rl = asRateLimit(e, model);
      if (rl) {
        if (rl.kind === "minute" && rl.retryAfterS <= maxWaitS && i < tries - 1) {
          await sleep(Math.max(1, rl.retryAfterS) * 1000 + 250);
          continue;
        }
        throw rl;
      }
      last = e;
      const retriable = !isTimeout(e) && ((errStatus(e) ?? 0) >= 500 || /fetch failed|ECONNRESET|overloaded/i.test(errText(e)));
      if (!retriable || i === tries - 1) break;
      await sleep([1500, 4000][i] ?? 4000);
    }
  }
  throw last;
}

function reasoningParams(model: string) {
  // gpt-oss models think before answering; "low" keeps answers fast and light on tokens
  return isGptOss(model) ? { reasoning_effort: "low" as const, include_reasoning: false } : {};
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

// ---------- embeddings (optional) ----------

/** Embeds passages, or returns null when embeddings are off or the service fails. */
export async function embedDocuments(items: { title: string; text: string }[]): Promise<number[][] | null> {
  if (!items.length || embedMode === "none") return null;
  const inputs = items.map((it) => `title: ${it.title} | text: ${it.text}`);
  if (embedMode === "mock") return inputs.map(mockEmbed);
  try {
    const out: number[][] = [];
    for (let i = 0; i < inputs.length; i += 50) {
      const batch = inputs.slice(i, i + 50);
      const res = await gemini().models.embedContent({
        model: EMBED_MODEL,
        contents: batch.map((t) => ({ parts: [{ text: t }] })),
        config: { outputDimensionality: EMBED_DIMS, abortSignal: AbortSignal.timeout(45_000) },
      });
      const embs = res.embeddings ?? [];
      if (embs.length !== batch.length) throw new Error(`Got ${embs.length} vectors for ${batch.length} passages.`);
      for (const e of embs) out.push(e.values ?? []);
    }
    return out;
  } catch (e) {
    console.error(`[gemini] embedding ${items.length} passages failed; using keyword search for them: ${errText(e).slice(0, 300)}`);
    return null;
  }
}

/** Embeds a question, or returns null so search falls back to keywords. */
export async function embedQuery(q: string): Promise<number[] | null> {
  if (embedMode === "none") return null;
  const input = `task: question answering | query: ${q}`;
  if (embedMode === "mock") return mockEmbed(input);
  try {
    const res = await gemini().models.embedContent({
      model: EMBED_MODEL,
      contents: [{ parts: [{ text: input }] }],
      config: { outputDimensionality: EMBED_DIMS, abortSignal: AbortSignal.timeout(8_000) },
    });
    return res.embeddings?.[0]?.values ?? null;
  } catch (e) {
    console.error(`[gemini] query embedding failed; using keyword search: ${errText(e).slice(0, 300)}`);
    return null;
  }
}

// ---------- generation ----------

export type ChatTurn = { role: "user" | "assistant"; text: string };
export type PromptSource = { n: number; docName: string; locator: string; page: number; text: string };

export const NOT_FOUND = "I couldn't find this in the published documents.";

const SYSTEM = `You answer questions about public policy documents.
Rules:
- Use ONLY the numbered sources provided. Never use outside knowledge, even if you know the answer.
- Cite every factual sentence with the source number in square brackets, like [1] or [2][3].
- If the sources do not contain the answer, reply exactly: "${NOT_FOUND}" and nothing else.
- Be concise and plain: short paragraphs or a short list. Quote exact figures, dates and names as written in the sources.
- Do not mention "sources" or "context" by name in prose; just cite with brackets.
- Plain text only: no tables, no headings, no HTML.`;

function buildPrompt(question: string, sources: PromptSource[], history: ChatTurn[]) {
  const ctx = sources.map((s) => `[${s.n}] ${s.docName}, ${s.locator} ${s.page}\n${s.text}`).join("\n\n");
  const hist = history
    .slice(-4)
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text.slice(0, 500)}`)
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

async function openStream(
  model: string,
  question: string,
  sources: PromptSource[],
  history: ChatTurn[],
  timeoutMs: number,
  maxWaitS: number
) {
  return withRetry(
    "answer",
    model,
    () =>
      groq().chat.completions.create(
        {
          model,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: buildPrompt(question, sources, history) },
          ],
          temperature: 0.2,
          max_completion_tokens: 1500,
          stream: true,
          ...reasoningParams(model),
        },
        { timeout: timeoutMs }
      ),
    maxWaitS
  );
}

/**
 * Streams an answer. If the main model is rate-limited before anything is sent,
 * the fallback model (a separate Groq quota) answers instead, when allowed.
 */
export async function* streamAnswer(
  question: string,
  sources: PromptSource[],
  history: ChatTurn[] = [],
  opts: { timeoutMs?: number; allowFallback?: boolean; maxWaitS?: number } = {}
): AsyncGenerator<string> {
  const { timeoutMs = 40_000, allowFallback = true, maxWaitS = 6 } = opts;
  if (aiMode === "mock") {
    for (const word of mockAnswer(question, sources).split(/(?<= )/)) yield word;
    return;
  }
  const t0 = Date.now();
  let model = CHAT_MODEL;
  let stream;
  try {
    stream = await openStream(model, question, sources, history, timeoutMs, maxWaitS);
  } catch (e) {
    if (!(e instanceof AiRateLimitError) || !allowFallback || CHAT_FALLBACK_MODEL === CHAT_MODEL) throw e;
    model = CHAT_FALLBACK_MODEL;
    stream = await openStream(model, question, sources, history, timeoutMs, maxWaitS);
  }
  let chars = 0;
  for await (const chunk of stream) {
    const text = chunk.choices?.[0]?.delta?.content;
    if (text) {
      chars += text.length;
      yield text;
    }
  }
  if (!chars) throw new Error("The model returned an empty answer.");
  console.log(`[groq] answer ok (${model}) in ${Date.now() - t0}ms, ${chars} chars`);
}

export async function answerOnce(question: string, sources: PromptSource[], maxWaitS = 25): Promise<string> {
  let out = "";
  // evaluation measures the configured model, so it waits rather than switching models
  for await (const t of streamAnswer(question, sources, [], { allowFallback: false, maxWaitS, timeoutMs: 45_000 })) out += t;
  return out.trim();
}

/** Structured JSON from the evaluation model, validated against a JSON schema. */
export async function generateJSON<T>(
  prompt: string,
  schema: { name: string; schema: Record<string, unknown> },
  mock: () => T,
  opts: { timeoutMs?: number; maxWaitS?: number; maxTokens?: number } = {}
): Promise<T> {
  if (aiMode === "mock") return mock();
  const { timeoutMs = 45_000, maxWaitS = 25, maxTokens = 3000 } = opts;
  const model = EVAL_MODEL;
  const call = (strict: boolean) =>
    withRetry(
      "json",
      model,
      () =>
        groq().chat.completions.create(
          {
            model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2,
            max_completion_tokens: maxTokens,
            response_format: strict
              ? { type: "json_schema", json_schema: { name: schema.name, strict: true, schema: schema.schema } }
              : { type: "json_object" },
            ...reasoningParams(model),
          },
          { timeout: timeoutMs }
        ),
      maxWaitS
    );
  let res;
  try {
    res = await call(true);
  } catch (e) {
    // models without strict structured outputs still support plain JSON mode
    if (errStatus(e) === 400 && /response_format|json_schema|structured/i.test(errText(e))) res = await call(false);
    else throw e;
  }
  const raw = (res.choices?.[0]?.message?.content ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  return JSON.parse(raw) as T;
}
