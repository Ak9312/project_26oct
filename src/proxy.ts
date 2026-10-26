import { NextResponse, type NextRequest } from "next/server";

/**
 * The admin page is only reachable at a secret path set in ADMIN_PATH
 * (for example "admin_x7k2p9"). Visiting /admin directly returns 404.
 * The password check on every admin API is the real protection; the secret
 * path just keeps the page out of sight.
 */
export function proxy(req: NextRequest) {
  const secret = (process.env.ADMIN_PATH || "").replace(/^\/+|\/+$/g, "");
  const { pathname } = req.nextUrl;
  const clean = pathname.replace(/\/+$/, "");

  if (secret && clean === `/${secret}`) {
    const url = req.nextUrl.clone();
    url.pathname = "/admin";
    return NextResponse.rewrite(url);
  }
  if (secret && (clean === "/admin" || pathname.startsWith("/admin/"))) {
    const url = req.nextUrl.clone();
    url.pathname = "/__not-found";
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next|favicon.ico|.*\\.).*)"],
};
