import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

let client: SupabaseClient | null = null;

// Service-role client for server-side code only (API routes, dispatch, cron).
// Bypasses RLS by design — every table has RLS enabled with no policies, so
// this key is the only path in. Never import this file from client code.
//
// Not parameterized with a generated Database type: every query site in this
// codebase already declares its own Row/Insert shape from db-types.ts and
// casts explicitly, which is more reliable here than supabase-js's generic
// inference (whose exact Database shape requirements are easy to get subtly
// wrong by hand and then get "never" errors everywhere instead of real ones).
export function supabaseAdmin(): SupabaseClient {
  if (!client) {
    client = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
