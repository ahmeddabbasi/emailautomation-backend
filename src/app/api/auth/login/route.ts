import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { createSessionToken, SESSION_COOKIE, SESSION_MAX_AGE } from "@/lib/auth/session";
import { cookieSecure } from "@/lib/auth/cookie";
import { checkLoginRateLimit, recordLoginFailure, clearLoginAttempts } from "@/lib/auth/rate-limit";
import { jsonError, handleRouteError } from "@/lib/api-helpers";
import { logWarning } from "@/lib/logger";

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function clientKey(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
}

export async function POST(request: NextRequest) {
  try {
    const key = clientKey(request);
    const rateLimit = await checkLoginRateLimit(key);
    if (!rateLimit.allowed) {
      logWarning("auth", "LOGIN_RATE_LIMITED", "Login blocked by rate limit", {
        details: { client: key, retryAfterSeconds: rateLimit.retryAfterSeconds },
      });
      return jsonError(429, `Too many attempts. Try again in ${Math.ceil((rateLimit.retryAfterSeconds ?? 900) / 60)} minutes.`);
    }

    const body = await request.json().catch(() => ({}));
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";

    const valid =
      timingSafeEqual(username, env.authUsername) && timingSafeEqual(password, env.authPassword);

    if (!valid) {
      await recordLoginFailure(key);
      logWarning("auth", "LOGIN_FAILED", "Login attempt with an invalid username or password", {
        details: { client: key, attemptedUsername: username.slice(0, 64) },
      });
      return jsonError(401, "Invalid username or password");
    }

    await clearLoginAttempts(key);
    const token = await createSessionToken(env.authSecret);

    const response = NextResponse.json({ ok: true });
    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: cookieSecure(request),
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE,
    });
    return response;
  } catch (err) {
    return handleRouteError(err, "auth");
  }
}
