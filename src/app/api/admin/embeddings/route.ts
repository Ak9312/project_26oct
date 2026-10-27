import { isAdmin, unauthorized } from "@/lib/auth";
import { addMissingEmbeddings } from "@/lib/ingest";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Adds embeddings to keyword-only passages, one batch per call. */
export async function POST() {
  if (!(await isAdmin())) return unauthorized();
  try {
    return Response.json(await addMissingEmbeddings());
  } catch (e) {
    console.error("adding embeddings failed", e);
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
