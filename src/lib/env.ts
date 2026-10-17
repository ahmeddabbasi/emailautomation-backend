// Central env var access. Every var is read lazily through a getter so a
// missing value fails loudly, at the call site that needed it, with a
// specific name — never as a downstream "fetch failed" or "undefined" bug.

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const env = {
  get supabaseUrl() {
    return required("SUPABASE_URL");
  },
  get supabaseServiceRoleKey() {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },
  get geminiApiKey() {
    return required("GEMINI_API_KEY");
  },
  get geminiModel() {
    return optional("GEMINI_MODEL", "gemini-flash-latest");
  },
  get mailgunApiKey() {
    return required("MAILGUN_API_KEY");
  },
  get mailgunDomain() {
    return required("MAILGUN_DOMAIN");
  },
  get mailgunFrom() {
    return optional("MAILGUN_FROM", `Email Outreach <outreach@${process.env.MAILGUN_DOMAIN ?? "example.com"}>`);
  },
  get mailgunBaseUrl() {
    return optional("MAILGUN_BASE_URL", "https://api.mailgun.net");
  },
  get mailgunWebhookSigningKey() {
    return required("MAILGUN_WEBHOOK_SIGNING_KEY");
  },
  // Groq is the fallback when Gemini is rate limited or unavailable. Both
  // are optional: without them generation runs on Gemini alone. The model is
  // deliberately not defaulted, so it is always an explicit choice.
  get groqApiKey() {
    return process.env.GROQ_API_KEY || null;
  },
  get groqModel() {
    return process.env.GROQ_MODEL || null;
  },
  get defaultSenderName() {
    return optional("DEFAULT_SENDER_NAME", "");
  },
  get defaultSenderTitle() {
    return optional("DEFAULT_SENDER_TITLE", "");
  },
  get cronSecret() {
    return required("CRON_SECRET");
  },
  get authUsername() {
    return required("AUTH_USERNAME");
  },
  get authPassword() {
    return required("AUTH_PASSWORD");
  },
  get authSecret() {
    return required("AUTH_SECRET");
  },
};
