import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken, SESSION_COOKIE } from "@/lib/auth/session";

const PUBLIC_PATHS = ["/", "/login"];
const PUBLIC_API_PREFIXES = ["/api/auth/login", "/api/cron/", "/api/webhooks/", "/api/unsubscribe", "/api/health/live"];

// Route handlers can't see their own URL from deep inside a library call, so
// the logger reads these to attach the request path/method to every entry.
function passThrough(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.set("x-request-path", request.nextUrl.pathname);
  headers.set("x-request-method", request.method);
  return NextResponse.next({ request: { headers } });
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.includes(pathname) || PUBLIC_API_PREFIXES.some((p) => pathname.startsWith(p))) {
    return passThrough(request);
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const authSecret = process.env.AUTH_SECRET;
  const authenticated = Boolean(token && authSecret && (await verifySessionToken(token, authSecret)));

  if (authenticated) return passThrough(request);

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon|sample-leads.csv).*)"],
};
