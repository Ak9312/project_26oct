import { isAdmin, unauthorized } from "@/lib/auth";
import { aiMode, CHAT_FALLBACK_MODEL, CHAT_MODEL, EMBED_MODEL, embedMode, EVAL_MODEL } from "@/lib/ai";
import { storageMode } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAdmin())) return unauthorized();
  return Response.json({
    storageMode,
    aiMode,
    chatModel: CHAT_MODEL,
    fallbackModel: CHAT_FALLBACK_MODEL,
    evalModel: EVAL_MODEL,
    embedMode,
    embedModel: EMBED_MODEL,
  });
}
