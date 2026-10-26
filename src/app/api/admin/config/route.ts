import { isAdmin, unauthorized } from "@/lib/auth";
import { aiMode, CHAT_MODEL, EMBED_MODEL } from "@/lib/ai";
import { storageMode } from "@/lib/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isAdmin())) return unauthorized();
  return Response.json({ storageMode, aiMode, chatModel: CHAT_MODEL, embedModel: EMBED_MODEL });
}
