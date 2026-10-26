import { NextResponse, type NextRequest } from "next/server";
import { adminSecretPath, createSessionToken, SESSION_COOKIE } from "@/lib/session";

/**
 * Two URLs:
 * - "/" is the public chat, open to everyone.
 * - "/<ADMIN_PATH>" is the private admin page. Visiting it signs you in with a signed,
 *   HTTP-only cookie that the admin APIs require. "/admin" itself always returns 404,
 *   so the admin page exists only at the secret path.
 */
export function proxy(req: NextRequest) {
  const secret = adminSecretPath();
  const { pathname } = req.nextUrl;
  const clean = pathname.replace(/\/+$/, "") || "/";

  if (secret.length >= 8 && clean === `/${secret}`) {
    const url = req.nextUrl.clone();
    url.pathname = "/admin";
    const res = NextResponse.rewrite(url);
    const { token, maxAge } = createSessionToken();
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge,
    });
    res.headers.set("Cache-Control", "private, no-store");
    res.headers.set("Referrer-Policy", "no-referrer");
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
    return res;
  }
  if (clean === "/admin" || pathname.startsWith("/admin/")) {
    const url = req.nextUrl.clone();
    url.pathname = "/__not-found";
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next|favicon.ico|.*\\.).*)"],
};
