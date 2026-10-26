import { isAdmin, unauthorized } from "@/lib/auth";
import { loadIndex } from "@/lib/index-store";
import { deleteDoc } from "@/lib/ingest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAdmin())) return unauthorized();
  const { data } = await loadIndex(true);
  return Response.json({ docs: data.docs, chunkCount: data.chunks.length, stats: data.stats, updatedAt: data.updatedAt });
}

export async function DELETE(req: Request) {
  if (!(await isAdmin())) return unauthorized();
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Missing document id." }, { status: 400 });
  const ok = await deleteDoc(id);
  return ok ? Response.json({ ok: true }) : Response.json({ error: "Document not found." }, { status: 404 });
}
