import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { encryptSecret, decryptSecret } from "@/lib/secret-box";
import { errorMessage } from "@/lib/errors";

export async function resolveGeminiApiKey(): Promise<string> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("app_settings")
      .select("gemini_key_ciphertext")
      .eq("id", true)
      .maybeSingle();
    if (!error && data?.gemini_key_ciphertext) {
      return decryptSecret(data.gemini_key_ciphertext, env.authSecret);
    }
  } catch {
    // A missing column or an unreadable value falls back to the server environment.
  }
  return process.env.GEMINI_API_KEY?.trim() || "";
}

export async function geminiKeySource(): Promise<"saved" | "environment" | "missing"> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("app_settings")
      .select("gemini_key_ciphertext")
      .eq("id", true)
      .maybeSingle();
    if (!error && data?.gemini_key_ciphertext) return "saved";
  } catch {
    // Fall through to the environment key.
  }
  return process.env.GEMINI_API_KEY?.trim() ? "environment" : "missing";
}

export async function saveGeminiApiKey(apiKey: string): Promise<void> {
  const ciphertext = encryptSecret(apiKey.trim(), env.authSecret);
  const { error } = await supabaseAdmin()
    .from("app_settings")
    .update({ gemini_key_ciphertext: ciphertext, updated_at: new Date().toISOString() })
    .eq("id", true);
  if (error) throw new Error(`Could not save the Gemini key: ${errorMessage(error)}`);
}

export function geminiKeyHint(apiKey: string): string {
  if (apiKey.length < 4) return "";
  return apiKey.slice(-4);
}
