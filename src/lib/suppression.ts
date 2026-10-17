import { createHmac, timingSafeEqual } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { normalizeEmail } from "@/lib/import-limits";
import { haltActiveEnrollmentsByEmail } from "@/lib/webhooks/handlers";

export function unsubscribeToken(email: string, secret: string): string {
  return createHmac("sha256", secret).update(normalizeEmail(email)).digest("base64url");
}

export function unsubscribeUrl(origin: string, email: string): string {
  const normalized = normalizeEmail(email);
  const token = unsubscribeToken(normalized, env.authSecret);
  return `${origin}/api/unsubscribe?email=${encodeURIComponent(normalized)}&token=${token}`;
}

export function tokenMatches(email: string, token: string, secret: string): boolean {
  const expected = unsubscribeToken(email, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function suppressEmail(email: string, reason: "unsubscribed" | "replied" | "bounced"): Promise<void> {
  const normalized = normalizeEmail(email);
  const db = supabaseAdmin();
  await db.from("suppressions").upsert({ email: normalized, reason });
  if (reason === "unsubscribed") await haltActiveEnrollmentsByEmail(normalized, "unsubscribed");
  if (reason === "bounced") await haltActiveEnrollmentsByEmail(normalized, "invalid");
  if (reason === "replied") await haltActiveEnrollmentsByEmail(normalized, "replied");
}

export async function isSuppressed(email: string): Promise<boolean> {
  const { data } = await supabaseAdmin().from("suppressions").select("email").eq("email", normalizeEmail(email)).maybeSingle();
  return Boolean(data);
}
