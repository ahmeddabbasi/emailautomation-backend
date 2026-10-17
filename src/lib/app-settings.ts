import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";
import { ExternalServiceError, errorMessage } from "@/lib/errors";

export interface AppDefaults {
  ctaLink: string;
  earlyBirdLine: string;
}

export async function getAppDefaults(): Promise<AppDefaults> {
  const { data, error } = await supabaseAdmin()
    .from("app_settings")
    .select("default_cta_link, default_early_bird_line")
    .eq("id", true)
    .maybeSingle();
  if (error) throw new ExternalServiceError("supabase", `Failed to load defaults: ${errorMessage(error)}`, error);
  return { ctaLink: data?.default_cta_link ?? "", earlyBirdLine: data?.default_early_bird_line ?? "" };
}

export async function saveAppDefaults(defaults: AppDefaults): Promise<void> {
  const { error } = await supabaseAdmin()
    .from("app_settings")
    .upsert({
      id: true,
      default_cta_link: defaults.ctaLink,
      default_early_bird_line: defaults.earlyBirdLine,
      updated_at: new Date().toISOString(),
    });
  if (error) throw new ExternalServiceError("supabase", `Failed to save defaults: ${errorMessage(error)}`, error);
}
