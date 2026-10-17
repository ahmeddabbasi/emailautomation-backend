import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";

const MAX_ATTEMPTS = 5;
const WINDOW_MS = 15 * 60 * 1000;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

// DB-backed so it holds across serverless invocations, unlike an in-memory
// counter. Window resets on its own after WINDOW_MS with no attempts.
export async function checkLoginRateLimit(key: string): Promise<RateLimitResult> {
  const db = supabaseAdmin();
  const { data } = await db.from("login_attempts").select("*").eq("key", key).maybeSingle();

  if (!data) return { allowed: true };

  const windowAge = Date.now() - new Date(data.window_start).getTime();
  if (windowAge > WINDOW_MS) return { allowed: true };

  if (data.count >= MAX_ATTEMPTS) {
    return { allowed: false, retryAfterSeconds: Math.ceil((WINDOW_MS - windowAge) / 1000) };
  }
  return { allowed: true };
}

export async function recordLoginFailure(key: string): Promise<void> {
  const db = supabaseAdmin();
  const { data } = await db.from("login_attempts").select("*").eq("key", key).maybeSingle();

  const windowAge = data ? Date.now() - new Date(data.window_start).getTime() : Infinity;

  if (!data || windowAge > WINDOW_MS) {
    await db.from("login_attempts").upsert({ key, count: 1, window_start: new Date().toISOString() });
  } else {
    await db.from("login_attempts").update({ count: data.count + 1 }).eq("key", key);
  }
}

export async function clearLoginAttempts(key: string): Promise<void> {
  const db = supabaseAdmin();
  await db.from("login_attempts").delete().eq("key", key);
}
