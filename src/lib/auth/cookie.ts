import type { NextRequest } from "next/server";

// The browser stores this cookie for the host it called. In the split deploy
// that host is the Vercel frontend, which proxies here and forwards
// x-forwarded-proto. Trust that over NODE_ENV so a local UI can still log in.
export function cookieSecure(request: NextRequest): boolean {
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  if (proto) return proto === "https";
  return process.env.NODE_ENV === "production";
}
