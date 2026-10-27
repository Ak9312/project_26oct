import { isAdmin, unauthorized } from "@/lib/auth";
import { aiErrorMessage, AiRateLimitError } from "@/lib/ai";
import { loadQuestions, runOne } from "@/lib/eval";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Runs a single test question; the admin page calls this once per question to show progress. */
export async function POST(req: Request) {
  if (!(await isAdmin())) return unauthorized();
  const { id } = (await req.json().catch(() => ({}))) as { id?: string };
  const set = await loadQuestions();
  const q = set?.questions.find((x) => x.id === id);
  if (!q) return Response.json({ error: "Question not found. Build the test set first." }, { status: 404 });
  try {
    return Response.json({ row: await runOne(q) });
  } catch (e) {
    console.error("eval question failed", e);
    if (e instanceof AiRateLimitError) {
      // the admin page waits this long and retries the same question
      return Response.json({ error: e.message, rateLimit: e.kind, retryAfterS: Math.ceil(e.retryAfterS) || 20 }, { status: 429 });
    }
    return Response.json({ error: aiErrorMessage(e) }, { status: 502 });
  }
}
