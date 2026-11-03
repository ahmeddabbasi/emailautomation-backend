import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";
import { env } from "@/lib/env";
import { encryptSecret, decryptSecret } from "@/lib/secret-box";
import { errorMessage } from "@/lib/errors";

async function readCiphertext(): Promise<string> {
  const { data, error } = await supabaseAdmin()
    .from("app_settings")
    .select("openai_key_ciphertext")
    .eq("id", true)
    .maybeSingle();
  if (error) throw new Error(errorMessage(error));
  return typeof data?.openai_key_ciphertext === "string" ? data.openai_key_ciphertext : "";
}

export async function resolveOpenAiApiKey(): Promise<string> {
  try {
    const ciphertext = await readCiphertext();
    if (ciphertext) return decryptSecret(ciphertext, env.authSecret);
  } catch {
    // A missing column or an unreadable value falls back to the server environment.
  }
  return process.env.OPENAI_API_KEY?.trim() || "";
}

export async function openAiKeySource(): Promise<"saved" | "environment" | "missing"> {
  try {
    const ciphertext = await readCiphertext();
    if (ciphertext) return "saved";
  } catch {
    // Fall through to the environment key.
  }
  return process.env.OPENAI_API_KEY?.trim() ? "environment" : "missing";
}

function missingColumn(err: unknown): boolean {
  const message = errorMessage(err);
  return /openai_key_ciphertext|writer_preference|42703|schema cache/i.test(message);
}

export async function writerPreference(): Promise<"auto" | "openai"> {
  try {
    const { data, error } = await supabaseAdmin()
      .from("app_settings")
      .select("writer_preference")
      .eq("id", true)
      .maybeSingle();
    if (error) throw new Error(errorMessage(error));
    return data?.writer_preference === "openai" ? "openai" : "auto";
  } catch {
    return "auto";
  }
}

export async function setWriterPreference(value: "auto" | "openai"): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("app_settings")
    .update({ writer_preference: value, updated_at: new Date().toISOString() })
    .eq("id", true);
  if (error) {
    if (missingColumn(error)) throw new Error("OpenAI settings are not in the database yet. Apply the latest migration.");
    throw new Error("Could not save the generation choice");
  }
}

export async function saveOpenAiApiKey(apiKey: string): Promise<void> {
  const ciphertext = encryptSecret(apiKey.trim(), env.authSecret);
  const { error } = await supabaseAdmin()
    .from("app_settings")
    .update({ openai_key_ciphertext: ciphertext, updated_at: new Date().toISOString() })
    .eq("id", true);
  if (error) {
    if (missingColumn(error)) throw new Error("OpenAI settings are not in the database yet. Apply the latest migration.");
    throw new Error("Could not save the OpenAI key");
  }
}

export async function clearOpenAiApiKey(): Promise<void> {
  const patch = { openai_key_ciphertext: "", writer_preference: "auto", updated_at: new Date().toISOString() };
  const first = await supabaseAdmin().from("app_settings").update(patch).eq("id", true);
  if (!first.error) return;
  if (!/writer_preference/i.test(errorMessage(first.error))) {
    if (missingColumn(first.error)) throw new Error("OpenAI settings are not in the database yet. Apply the latest migration.");
    throw new Error("Could not remove the OpenAI key");
  }
  const second = await supabaseAdmin()
    .from("app_settings")
    .update({ openai_key_ciphertext: "", updated_at: patch.updated_at })
    .eq("id", true);
  if (second.error) throw new Error("Could not remove the OpenAI key");
}
