import "server-only";
import { createHmac, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "pka_admin";
const SESSION_HOURS = 12;

export const adminConfigured = () => !!process.env.ADMIN_PASSWORD;

function key() {
  return createHmac("sha256", "pka-session-v1").update(process.env.ADMIN_PASSWORD ?? "").digest();
}

function sign(payload: string) {
  return createHmac("sha256", key()).update(payload).digest("base64url");
}

export function checkPassword(input: string) {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  const a = createHmac("sha256", "cmp").update(input).digest();
  const b = createHmac("sha256", "cmp").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function createSessionToken() {
  const exp = Date.now() + SESSION_HOURS * 3600_000;
  return { token: `${exp}.${sign(String(exp))}`, maxAge: SESSION_HOURS * 3600 };
}

export function verifySessionToken(token: string | undefined) {
  if (!token || !adminConfigured()) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = Buffer.from(sign(exp));
  const got = Buffer.from(sig);
  return good.length === got.length && timingSafeEqual(good, got);
}

export async function isAdmin() {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

export function unauthorized() {
  return Response.json({ error: "Sign in to the admin page first." }, { status: 401 });
}
