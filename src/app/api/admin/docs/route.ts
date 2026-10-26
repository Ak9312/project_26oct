import { isAdmin, unauthorized } from "@/lib/auth";
import { loadIndex } from "@/lib/index-store";
import { deleteDocs } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  if (!(await isAdmin())) return unauthorized();
  const { data } = await loadIndex(true);
  return Response.json({ docs: data.docs, chunkCount: data.chunks.length, stats: data.stats, updatedAt: data.updatedAt });
}

/** DELETE ?id=<doc id> removes one document; DELETE ?all=1 removes every document. */
export async function DELETE(req: Request) {
  if (!(await isAdmin())) return unauthorized();
  const params = new URL(req.url).searchParams;
  const id = params.get("id");
  const all = params.get("all") === "1";
  if (!id && !all) return Response.json({ error: "Missing document id." }, { status: 400 });
  try {
    const removed = await deleteDocs(all ? "all" : [id!]);
    if (!removed && !all) return Response.json({ error: "That document was already removed." }, { status: 404 });
    const { data } = await loadIndex(true);
    return Response.json({ removed, docs: data.docs, chunkCount: data.chunks.length, stats: data.stats });
  } catch (e) {
    console.error("delete failed", e);
    return Response.json({ error: "Couldn't remove the document. Try again." }, { status: 500 });
  }
}
