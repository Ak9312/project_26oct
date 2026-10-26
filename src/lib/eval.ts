import "server-only";
import { aiErrorMessage, aiMode, answerOnce, CHAT_MODEL, EMBED_MODEL, embedQuery, generateJSON, NOT_FOUND } from "./ai";
import { loadIndex } from "./index-store";
import { countDuplicates, retrieveNaive, retrieveUnique, type Scored } from "./retrieve";
import { readJSON, writeJSON } from "./storage";
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
  // Batches of 5 passages run in parallel (3 at a time) so the whole build fits the time limit.
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
Return JSON: [{"n": <passage number>, "question": "...", "answer": "..."}]

${batch.map((c, j) => `Passage ${j + 1} (from "${c.docName}"):\n${c.text}`).join("\n\n")}`;
      try {
        results[idx] = await generateJSON<GenItem[]>(prompt, () =>
          batch.map((c, j) => {
            const sentence = c.text.split(/(?<=[.!?])\s+/).find((s) => s.length > 60) ?? c.text.slice(0, 160);
            const words = sentence.split(/\s+/).slice(0, 9).join(" ").replace(/[^\w\s-]/g, "");
            return { n: j + 1, question: `What does the policy say about ${words.toLowerCase()}?`, answer: sentence.slice(0, 200) };
          })
        );
      } catch (e) {
        lastError = e;
        console.error(`question batch ${idx + 1} failed`, e);
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);

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
    method: `Generated by ${aiMode === "mock" ? "offline mock" : CHAT_MODEL} from ${passages.length} passages spread across ${new Set(passages.map((p) => p.docId)).size} documents.`,
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
  const { data, vectors } = await loadIndex();
  const qv = Float32Array.from(await embedQuery(q.question));

  const improved = retrieveUnique(qv, data.chunks, vectors, EVAL_K);

  // Baseline: reproduce the class-notebook bug, i.e. every file indexed twice with plain top-k.
  const doubled = [...data.chunks, ...data.chunks.map((c) => ({ ...c, id: c.id + "#dup" }))];
  const dupVectors = new Map(vectors);
  for (const c of data.chunks) dupVectors.set(c.id + "#dup", vectors.get(c.id)!);
  const naive = retrieveNaive(qv, doubled, dupVectors, EVAL_K);

  const sources = improved.map((s, i) => ({
    n: i + 1,
    docName: s.chunk.docName,
    locator: s.chunk.locator,
    page: s.chunk.page,
    text: s.chunk.text,
  }));
  const answer = await answerOnce(q.question, sources);
  const latencyMs = Date.now() - t0;
  const notFound = answer.startsWith(NOT_FOUND.slice(0, 25));

  const judge = await generateJSON<Judge>(
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
    () => {
      const ref = new Set(q.expectedAnswer.toLowerCase().split(/\W+/).filter((w) => w.length > 4));
      const got = answer.toLowerCase().split(/\W+/).filter((w) => ref.has(w)).length;
      return { faithful: true, correct: !notFound && got >= Math.min(3, ref.size), note: "Mock grader (word overlap)." };
    }
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
    embedModel: EMBED_MODEL,
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
