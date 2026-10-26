import "server-only";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "./session";

export { adminConfigured } from "./session";

export async function isAdmin() {
  const store = await cookies();
  return verifySessionToken(store.get(SESSION_COOKIE)?.value);
}

export function unauthorized() {
  return Response.json({ error: "Open the admin page from its private link first." }, { status: 401 });
}
