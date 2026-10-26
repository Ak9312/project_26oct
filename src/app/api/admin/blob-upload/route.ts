import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { isAdmin, unauthorized } from "@/lib/auth";
import { MAX_FILE_BYTES } from "@/lib/ingest";

export const runtime = "nodejs";

/** Issues short-lived tokens so the browser can upload large files straight to private Blob storage. */
export async function POST(req: Request) {
  if (!(await isAdmin())) return unauthorized();
  const body = (await req.json()) as HandleUploadBody;
  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith("uploads/")) throw new Error("Invalid upload path.");
        return {
          maximumSizeInBytes: MAX_FILE_BYTES,
          addRandomSuffix: false,
          allowOverwrite: true,
        };
      },
    });
    return Response.json(result);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
