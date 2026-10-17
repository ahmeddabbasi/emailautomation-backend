import { NextRequest, NextResponse } from "next/server";
import { cookieSecure } from "@/lib/auth/cookie";
import { SESSION_COOKIE } from "@/lib/auth/session";

export async function POST(request: NextRequest) {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    secure: cookieSecure(request),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
