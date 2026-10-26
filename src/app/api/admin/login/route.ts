import { cookies } from "next/headers";
import { adminConfigured, checkPassword, createSessionToken, SESSION_COOKIE } from "@/lib/auth";
import { clientIp, rateLimit } from "@/lib/ratelimit";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!adminConfigured()) {
    return Response.json({ error: "ADMIN_PASSWORD isn't set on the server yet." }, { status: 503 });
  }
  const limit = rateLimit("login:" + clientIp(req), 8, 15 * 60_000);
  if (!limit.ok) {
    return Response.json({ error: `Too many attempts. Try again in ${Math.ceil(limit.retryAfterS / 60)} minutes.` }, { status: 429 });
  }
  const { password } = (await req.json().catch(() => ({}))) as { password?: string };
  if (!password || !checkPassword(password)) {
    return Response.json({ error: "That password isn't right." }, { status: 401 });
  }
  const { token, maxAge } = createSessionToken();
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge,
  });
  return Response.json({ ok: true });
}
