import { isAdmin, unauthorized } from "@/lib/auth";
import { loadIndex, type Loaded } from "@/lib/index-store";
import { deleteDocs } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Documents with a live count of passages that have usable embeddings. */
function docsWithEmbeddingCounts(loaded: Loaded) {
  const counts = new Map<string, number>();
  for (const c of loaded.data.chunks) if (loaded.vectors.has(c.id)) counts.set(c.docId, (counts.get(c.docId) ?? 0) + 1);
  return loaded.data.docs.map((d) => ({ ...d, embeddedCount: counts.get(d.id) ?? 0 }));
}

function body(loaded: Loaded) {
  const { data } = loaded;
  return { docs: docsWithEmbeddingCounts(loaded), chunkCount: data.chunks.length, stats: data.stats, updatedAt: data.updatedAt };
}

export async function GET() {
  if (!(await isAdmin())) return unauthorized();
  return Response.json(body(await loadIndex(true)));
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
    return Response.json({ removed, ...body(await loadIndex(true)) });
  } catch (e) {
    console.error("delete failed", e);
    return Response.json({ error: "Couldn't remove the document. Try again." }, { status: 500 });
  }
}
