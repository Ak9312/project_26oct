import { isAdmin, unauthorized } from "@/lib/auth";
import { AiNotConfiguredError, aiMode } from "@/lib/ai";
import { DuplicateFileError, ingestFile, MAX_FILE_BYTES } from "@/lib/ingest";
import { deleteFile, readFileBuf, storageMode } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Indexes one file. Two ways in:
 * - multipart form with `file` (local development, small files)
 * - JSON { pathname, name } for a file the browser already uploaded to Blob storage
 */
export async function POST(req: Request) {
  if (!(await isAdmin())) return unauthorized();
  if (aiMode === "missing") return Response.json({ error: new AiNotConfiguredError().message }, { status: 503 });

  let buf: Buffer;
  let name: string;
  let replace = false;
  let blobPathname: string | undefined;

  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return Response.json({ error: "Choose a file to upload." }, { status: 400 });
    if (file.size > MAX_FILE_BYTES) return Response.json({ error: "File is larger than 10 MB." }, { status: 413 });
    buf = Buffer.from(await file.arrayBuffer());
    name = file.name;
    replace = form.get("replace") === "1";
  } else {
    const body = (await req.json().catch(() => ({}))) as { pathname?: string; name?: string; replace?: boolean };
    if (storageMode !== "blob" || !body.pathname?.startsWith("uploads/") || !body.name) {
      return Response.json({ error: "Invalid upload reference." }, { status: 400 });
    }
    const got = await readFileBuf(body.pathname);
    if (!got) return Response.json({ error: "Uploaded file not found in storage." }, { status: 404 });
    buf = got;
    name = body.name;
    replace = !!body.replace;
    blobPathname = body.pathname;
  }

  try {
    const result = await ingestFile({ buf, name, replace, blobPathname });
    return Response.json(result);
  } catch (e) {
    if (e instanceof DuplicateFileError) {
      // the copy that was just uploaded is not needed
      if (blobPathname && blobPathname !== e.existing.blobPathname) await deleteFile(blobPathname);
      return Response.json(
        { error: e.message, duplicate: true, match: e.match, existing: { id: e.existing.id, name: e.existing.name, uploadedAt: e.existing.uploadedAt } },
        { status: 409 }
      );
    }
    console.error("ingest failed", e);
    return Response.json({ error: (e as Error).message || "Indexing failed." }, { status: 422 });
  }
}
