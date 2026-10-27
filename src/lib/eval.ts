import "server-only";
import { aiErrorMessage, aiMode, AiRateLimitError, answerOnce, CHAT_MODEL, EMBED_MODEL, embedMode, embedQuery, EVAL_MODEL, generateJSON, NOT_FOUND } from "./ai";
import { loadIndex } from "./index-store";
import { countDuplicates, rankChunks, retrieveNaive, retrieveUnique, type Scored } from "./retrieve";
import { deleteFile, readJSON, writeJSON } from "./storage";
import type {
  ChunkRecord,
  EvalQuestion,
  EvalQuestionSet,
  EvalResultRow,
  EvalRetrievalResult,
  EvalSummary,
} from "./types";

export const EVAL_K = 5;
export const EVAL_SIZE = 25;
const Q_PATH = "eval/questions.json";
const R_PATH = "eval/results.json";

export const loadQuestions = () => readJSON<EvalQuestionSet>(Q_PATH);
export const loadResults = () => readJSON<EvalSummary>(R_PATH);
export const saveQuestions = (s: EvalQuestionSet) => writeJSON(Q_PATH, s);
export const saveResults = (s: EvalSummary) => writeJSON(R_PATH, s);

/**
 * Keeps the test set in step with the library: questions written from removed
 * documents are dropped, and saved results that used them are cleared.
 */
export async function pruneEvalForRemovedDocs(removed: { chunkIds: Set<string>; names: Set<string> }, all: boolean) {
  if (all) {
    await Promise.allSettled([deleteFile(Q_PATH), deleteFile(R_PATH)]);
    return;
  }
  const set = await loadQuestions().catch(() => null);
  if (set) {
    const keep = set.questions.filter((q) => !removed.chunkIds.has(q.goldChunkId));
    if (keep.length !== set.questions.length) {
      if (keep.length) await saveQuestions({ ...set, questions: keep });
      else await deleteFile(Q_PATH);
    }
  }
  const results = await loadResults().catch(() => null);
  if (results?.rows.some((r) => removed.names.has(r.docName))) await deleteFile(R_PATH);
}

/** Pick passages spread evenly across every document and page range. */
function pickPassages(chunks: ChunkRecord[], n: number): ChunkRecord[] {
  const byDoc = new Map<string, ChunkRecord[]>();
  for (const c of chunks) {
    if (c.text.length < 200) continue;
    byDoc.set(c.docId, [...(byDoc.get(c.docId) ?? []), c]);
  }
  const docs = [...byDoc.values()];
  if (!docs.length) return [];
  const per = docs.map((list, i) => Math.floor(n / docs.length) + (i < n % docs.length ? 1 : 0));
  const picked: ChunkRecord[] = [];
  docs.forEach((list, i) => {
    const want = Math.min(per[i], list.length);
    const step = list.length / want;
    for (let j = 0; j < want; j++) picked.push(list[Math.floor(j * step + step / 2)]);
  });
  // top up from the largest documents if some were too small
  const used = new Set(picked.map((p) => p.id));
  const rest = docs.flat().filter((c) => !used.has(c.id));
  while (picked.length < n && rest.length) picked.push(rest.splice(Math.floor(rest.length / 2), 1)[0]);
  return picked.slice(0, n);
}

type GenItem = { n: number; question: string; answer: string };

const QUESTIONS_SCHEMA = {
  name: "test_questions",
  schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: { n: { type: "integer" }, question: { type: "string" }, answer: { type: "string" } },
          required: ["n", "question", "answer"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
};

const JUDGE_SCHEMA = {
  name: "grade",
  schema: {
    type: "object",
    properties: { faithful: { type: "boolean" }, correct: { type: "boolean" }, note: { type: "string" } },
    required: ["faithful", "correct", "note"],
    additionalProperties: false,
  },
};

/**
 * Builds the 25-question test set. Each question is written by the model from one specific
 * indexed passage, so the correct source (document and page) is known for scoring.
 */
export async function generateQuestionSet(n = EVAL_SIZE): Promise<EvalQuestionSet> {
  const { data } = await loadIndex(true);
  const passages = pickPassages(data.chunks, n);
  if (passages.length < 5) {
    throw new Error("Upload more documents first: at least 5 substantial passages are needed.");
  }
  // Batches of 5 passages, two at a time: fast enough for the time limit while staying
  // under Groq's per-minute token limit.
  const batches: ChunkRecord[][] = [];
  for (let i = 0; i < passages.length; i += 5) batches.push(passages.slice(i, i + 5));
  const results: (GenItem[] | null)[] = new Array(batches.length).fill(null);
  let lastError: unknown = null;
  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const idx = next++;
      const batch = batches[idx];
      const prompt = `You are building a test set for a policy-document search assistant.
For EACH numbered passage, write one question a member of the public might ask that is answered
specifically and only by that passage, plus a short correct answer (under 30 words) taken from it.
Rules: the question must make sense on its own (name the policy or topic; never say "this passage",
"the document" or "the text"); prefer concrete facts such as targets, years, numbers, definitions,
responsibilities or penalties; do not ask yes/no questions.
Return JSON: {"items": [{"n": <passage number>, "question": "...", "answer": "..."}]} with one item per passage.

${batch.map((c, j) => `Passage ${j + 1} (from "${c.docName}"):\n${c.text}`).join("\n\n")}`;
      try {
        const out = await generateJSON<{ items: GenItem[] }>(prompt, QUESTIONS_SCHEMA, () => ({
          items: batch.map((c, j) => {
            const sentence = c.text.split(/(?<=[.!?])\s+/).find((s) => s.length > 60) ?? c.text.slice(0, 160);
            const words = sentence.split(/\s+/).slice(0, 9).join(" ").replace(/[^\w\s-]/g, "");
            return { n: j + 1, question: `What does the policy say about ${words.toLowerCase()}?`, answer: sentence.slice(0, 200) };
          }),
        }));
        results[idx] = out.items;
      } catch (e) {
        lastError = e;
        console.error(`question batch ${idx + 1} failed`, e);
        // a used-up daily limit won't recover during this request
        if (e instanceof AiRateLimitError && e.kind === "day") next = batches.length;
      }
    }
  }
  await Promise.all([worker(), worker()]);

  const questions: EvalQuestion[] = [];
  results.forEach((items, idx) => {
    const batch = batches[idx];
    for (const it of Array.isArray(items) ? items : []) {
      const c = batch[(it.n ?? 0) - 1];
      if (!c || !it.question) continue;
      questions.push({
        id: `q${questions.length + 1}`,
        question: String(it.question).trim(),
        expectedAnswer: String(it.answer ?? "").trim(),
        goldChunkId: c.id,
        docName: c.docName,
        page: c.page,
      });
    }
  });
  if (questions.length < 5) {
    throw new Error(lastError ? aiErrorMessage(lastError) : "Not enough questions could be written. Try again.");
  }
  const set: EvalQuestionSet = {
    createdAt: new Date().toISOString(),
    method: `Generated by ${aiMode === "mock" ? "offline mock" : EVAL_MODEL} from ${passages.length} passages spread across ${new Set(passages.map((p) => p.docId)).size} documents.`,
    questions: questions.slice(0, n),
  };
  await saveQuestions(set);
  return set;
}

function score(results: Scored[], q: EvalQuestion): EvalRetrievalResult {
  const idx = results.findIndex(
    (r) => r.chunk.id.replace(/#dup$/, "") === q.goldChunkId || (r.chunk.docName === q.docName && r.chunk.page === q.page)
  );
  return {
    hit: idx >= 0,
    rank: idx >= 0 ? idx + 1 : null,
    duplicatesInTopK: countDuplicates(results),
    retrieved: results.map((r) => ({
      chunkId: r.chunk.id,
      docName: r.chunk.docName,
      page: r.chunk.page,
      score: Math.round(r.score * 1000) / 1000,
    })),
  };
}

type Judge = { faithful: boolean; correct: boolean; note: string };

export async function runOne(q: EvalQuestion): Promise<EvalResultRow> {
  const t0 = Date.now();
  const loaded = await loadIndex();
  const { ranked, mode } = rankChunks(loaded, q.question, await embedQuery(q.question));

  const improved = retrieveUnique(loaded, ranked, EVAL_K);
  // Baseline: reproduce the class-notebook bug, i.e. every file indexed twice with plain top-k.
  const naive = retrieveNaive(ranked, EVAL_K);

  const sources = improved.map((s, i) => ({
    n: i + 1,
    docName: s.chunk.docName,
    locator: s.chunk.locator,
    page: s.chunk.page,
    text: s.chunk.text,
  }));
  const answer = sources.length ? await answerOnce(q.question, sources) : NOT_FOUND;
  const latencyMs = Date.now() - t0;
  const notFound = answer.startsWith(NOT_FOUND.slice(0, 25));

  const judge: Judge = notFound
    ? { faithful: true, correct: false, note: "No answer was found in the retrieved passages." }
    : await generateJSON<Judge>(
    `You are grading a retrieval-augmented answer.
Question: ${q.question}
Reference answer: ${q.expectedAnswer}
Sources given to the assistant:
${sources.map((s) => `[${s.n}] ${s.text}`).join("\n\n")}

Assistant answer:
${answer}

Return JSON {"faithful": bool, "correct": bool, "note": "<one short sentence>"}.
faithful = every claim in the answer is supported by the sources (an "I couldn't find this" reply counts as faithful).
correct = the answer conveys the substance of the reference answer.`,
    JUDGE_SCHEMA,
    () => {
      const ref = new Set(q.expectedAnswer.toLowerCase().split(/\W+/).filter((w) => w.length > 4));
      const got = answer.toLowerCase().split(/\W+/).filter((w) => ref.has(w)).length;
      return { faithful: true, correct: !notFound && got >= Math.min(3, ref.size), note: "Mock grader (word overlap)." };
    },
    { maxTokens: 800 }
  );

  return {
    id: q.id,
    question: q.question,
    expectedAnswer: q.expectedAnswer,
    docName: q.docName,
    page: q.page,
    improved: score(improved, q),
    naive: score(naive, q),
    answer,
    notFound,
    faithful: !!judge.faithful,
    correct: !!judge.correct,
    judgeNote: String(judge.note ?? ""),
    latencyMs,
    searchMode: mode,
  };
}

export function summarize(rows: EvalResultRow[]): EvalSummary {
  const n = rows.length || 1;
  const agg = (pick: (r: EvalResultRow) => EvalRetrievalResult) => ({
    hitRate: rows.filter((r) => pick(r).hit).length / n,
    mrr: rows.reduce((a, r) => a + (pick(r).rank ? 1 / pick(r).rank! : 0), 0) / n,
    duplicateRate: rows.reduce((a, r) => a + pick(r).duplicatesInTopK, 0) / (n * EVAL_K),
  });
  return {
    runAt: new Date().toISOString(),
    aiMode,
    chatModel: CHAT_MODEL,
    judgeModel: EVAL_MODEL,
    embedModel: embedMode === "none" ? "none" : EMBED_MODEL,
    searchMode: rows.every((r) => r.searchMode === "hybrid") ? "hybrid" : rows.some((r) => r.searchMode === "hybrid") ? "mixed" : "keyword",
    k: EVAL_K,
    total: rows.length,
    improved: agg((r) => r.improved),
    naive: agg((r) => r.naive),
    faithfulness: rows.filter((r) => r.faithful).length / n,
    correctness: rows.filter((r) => r.correct).length / n,
    avgLatencyMs: rows.reduce((a, r) => a + r.latencyMs, 0) / n,
    rows,
  };
}
