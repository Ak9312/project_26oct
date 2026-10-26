import { isAdmin, unauthorized } from "@/lib/auth";
import { aiErrorMessage } from "@/lib/ai";
import { generateQuestionSet, loadQuestions, loadResults, pruneEvalForRemovedDocs } from "@/lib/eval";
import { loadIndex } from "@/lib/index-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Returns the saved test set, first dropping questions whose source passage is no longer indexed. */
export async function GET() {
  if (!(await isAdmin())) return unauthorized();
  const set = await loadQuestions();
  if (set) {
    const { data } = await loadIndex(true);
    const live = new Set(data.chunks.map((c) => c.id));
    const stale = set.questions.filter((q) => !live.has(q.goldChunkId));
    if (stale.length) {
      await pruneEvalForRemovedDocs(
        { chunkIds: new Set(stale.map((q) => q.goldChunkId)), names: new Set(stale.map((q) => q.docName)) },
        !data.chunks.length
      );
      return Response.json({ set: await loadQuestions(), summary: await loadResults() });
    }
  }
  return Response.json({ set });
}

/** Builds (or rebuilds) the 25-question test set from the indexed documents. */
export async function POST() {
  if (!(await isAdmin())) return unauthorized();
  try {
    return Response.json({ set: await generateQuestionSet() });
  } catch (e) {
    console.error("question generation failed", e);
    const msg = (e as Error).message;
    return Response.json(
      { error: msg.startsWith("Upload more") || msg.startsWith("Not enough") ? msg : aiErrorMessage(e) },
      { status: 422 }
    );
  }
}
