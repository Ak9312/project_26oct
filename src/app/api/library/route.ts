import { loadIndex } from "@/lib/index-store";
import { loadQuestions } from "@/lib/eval";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Public, read-only view of what the assistant can answer from. */
export async function GET() {
  const { data } = await loadIndex();
  const qs = await loadQuestions().catch(() => null);
  return Response.json({
    documents: data.docs.map((d) => ({ name: d.name, pages: d.pages, kind: d.kind })),
    chunkCount: data.chunks.length,
    // only suggest questions whose source document is still in the library
    suggestions: (qs?.questions ?? [])
      .filter((q) => data.docs.some((d) => d.name === q.docName))
      .filter((_, i) => i % 8 === 0)
      .slice(0, 3)
      .map((q) => q.question),
    updatedAt: data.updatedAt,
  });
}
