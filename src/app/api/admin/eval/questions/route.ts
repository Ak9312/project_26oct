import { isAdmin, unauthorized } from "@/lib/auth";
import { generateQuestionSet, loadQuestions } from "@/lib/eval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  if (!(await isAdmin())) return unauthorized();
  return Response.json({ set: await loadQuestions() });
}

/** Builds (or rebuilds) the 25-question test set from the indexed documents. */
export async function POST() {
  if (!(await isAdmin())) return unauthorized();
  try {
    return Response.json({ set: await generateQuestionSet() });
  } catch (e) {
    console.error("question generation failed", e);
    return Response.json({ error: (e as Error).message }, { status: 422 });
  }
}
