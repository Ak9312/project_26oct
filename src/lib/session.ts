import { createHmac, timingSafeEqual } from "crypto";

/**
 * Admin access is granted by visiting the secret admin URL (ADMIN_PATH).
 * That visit sets a signed, HTTP-only cookie; every admin API checks it.
 * The signature key is derived from ADMIN_PATH, so changing the path
 * immediately signs out every existing session.
 */
export const SESSION_COOKIE = "pka_admin";
export const SESSION_HOURS = 12;

export function adminSecretPath() {
  return (process.env.ADMIN_PATH || "").replace(/^\/+|\/+$/g, "");
}

export const adminConfigured = () => adminSecretPath().length >= 8;

function key() {
  return createHmac("sha256", "pka-session-v2").update(adminSecretPath()).digest();
}

function sign(payload: string) {
  return createHmac("sha256", key()).update(payload).digest("base64url");
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
