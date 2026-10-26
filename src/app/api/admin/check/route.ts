import { isAdmin, unauthorized } from "@/lib/auth";
import { findBySha } from "@/lib/ingest";

export const runtime = "nodejs";

/** Called by the upload form with the file's SHA-256 before any bytes are sent. */
export async function POST(req: Request) {
  if (!(await isAdmin())) return unauthorized();
  const { sha256 } = (await req.json().catch(() => ({}))) as { sha256?: string };
  if (!sha256 || !/^[a-f0-9]{64}$/.test(sha256)) return Response.json({ error: "Invalid fingerprint." }, { status: 400 });
  const existing = await findBySha(sha256);
  return Response.json({ duplicate: !!existing, existing: existing ? { id: existing.id, name: existing.name, uploadedAt: existing.uploadedAt } : null });
}
