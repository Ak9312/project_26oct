import { isAdmin, unauthorized } from "@/lib/auth";
import { loadResults, saveResults, summarize } from "@/lib/eval";
import type { EvalResultRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAdmin())) return unauthorized();
  return Response.json({ summary: await loadResults() });
}

/** Saves a completed run. */
export async function POST(req: Request) {
  if (!(await isAdmin())) return unauthorized();
  const { rows } = (await req.json().catch(() => ({}))) as { rows?: EvalResultRow[] };
  if (!Array.isArray(rows) || !rows.length) return Response.json({ error: "No results to save." }, { status: 400 });
  const summary = summarize(rows);
  await saveResults(summary);
  return Response.json({ summary });
}
