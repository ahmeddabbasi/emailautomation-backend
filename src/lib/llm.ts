import "server-only";
import { GoogleGenAI, Type } from "@google/genai";
import { env } from "@/lib/env";
import { ExternalServiceError, alreadyLogged, errorMessage } from "@/lib/errors";
import { logError, logWarning } from "@/lib/logger";
import type { GenerationProvider } from "@/lib/supabase/db-types";

export interface EmailJson {
  subject: string;
  body: string;
}

// Identifies what a model call was for, so every log entry it produces can be
// traced back to the campaign, list and contact involved.
export interface LlmContext {
  purpose: "email" | "test_email" | "company_brief";
  campaignId?: string;
  leadListId?: string;
  contactId?: string;
  campaignContactId?: string;
  sequenceStep?: number;
}

type FailureKind = "rate_limit" | "unavailable" | "server_error" | "auth" | "bad_request" | "bad_response" | "other";

const KIND_CODE: Record<FailureKind, string> = {
  rate_limit: "RATE_LIMIT",
  unavailable: "UNAVAILABLE",
  server_error: "SERVER_ERROR",
  auth: "AUTH_FAILED",
  bad_request: "BAD_REQUEST",
  bad_response: "BAD_RESPONSE",
  other: "REQUEST_FAILED",
};

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [1000, 3000];
const REQUEST_TIMEOUT_MS = 45000;
// Once Gemini is rate limited or down, skip it for a while instead of paying
// three failed attempts per contact for the rest of a batch.
const GEMINI_COOLDOWN_MS = 5 * 60 * 1000;
let geminiCooldownUntil = 0;

class ProviderError extends Error {
  constructor(
    public readonly provider: GenerationProvider,
    public readonly kind: FailureKind,
    message: string,
    public readonly httpStatus?: number,
    public readonly providerBody?: string
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

function classify(status: number | undefined, text: string): FailureKind {
  if (status === 429 || /RESOURCE_EXHAUSTED|rate.?limit|quota/i.test(text)) return "rate_limit";
  if (status === 503 || /UNAVAILABLE|overloaded|high demand/i.test(text)) return "unavailable";
  if (status === 401 || status === 403 || /API_KEY_INVALID|PERMISSION_DENIED|invalid api key/i.test(text)) return "auth";
  if (status !== undefined && status >= 500) return "server_error";
  if (status === 400 || status === 404 || status === 422 || /INVALID_ARGUMENT/.test(text)) return "bad_request";
  return "other";
}

const retryable = (kind: FailureKind) => kind === "rate_limit" || kind === "unavailable" || kind === "server_error";
const fallbackEligible = (kind: FailureKind) => kind === "rate_limit" || kind === "unavailable";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEmailJson(provider: GenerationProvider, text: string | null | undefined): EmailJson {
  if (!text) throw new ProviderError(provider, "bad_response", "Model returned an empty response");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderError(provider, "bad_response", "Model response was not valid JSON", undefined, text.slice(0, 500));
  }
  const candidate = parsed as Partial<EmailJson>;
  if (typeof candidate.subject !== "string" || typeof candidate.body !== "string") {
    throw new ProviderError(provider, "bad_response", "Model response was missing subject/body fields", undefined, text.slice(0, 500));
  }
  return { subject: candidate.subject, body: candidate.body };
}

let geminiClient: GoogleGenAI | null = null;

async function callGemini(prompt: string, mode: "email" | "text"): Promise<string> {
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({ apiKey: env.geminiApiKey, httpOptions: { timeout: REQUEST_TIMEOUT_MS } });
  }
  try {
    const response = await geminiClient.models.generateContent({
      model: env.geminiModel,
      contents: prompt,
      config:
        mode === "email"
          ? {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: { subject: { type: Type.STRING }, body: { type: Type.STRING } },
                required: ["subject", "body"],
              },
              temperature: 0.8,
            }
          : { temperature: 0.3 },
    });
    if (!response.text) throw new ProviderError("gemini", "bad_response", "Gemini returned an empty response");
    return response.text;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    const status = (err as { status?: number }).status;
    const message = errorMessage(err);
    throw new ProviderError("gemini", classify(status, message), message, status, message.slice(0, 1000));
  }
}

const GROQ_JSON_INSTRUCTION =
  'Respond with only a JSON object of the form {"subject": "...", "body": "..."} and nothing else.';

async function callGroq(prompt: string, mode: "email" | "text"): Promise<string> {
  const apiKey = env.groqApiKey;
  const model = env.groqModel;
  if (!apiKey || !model) throw new ProviderError("groq", "other", "Groq is not configured");

  let res: Response;
  try {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: mode === "email" ? 0.8 : 0.3,
        messages:
          mode === "email"
            ? [
                { role: "system", content: GROQ_JSON_INSTRUCTION },
                { role: "user", content: prompt },
              ]
            : [{ role: "user", content: prompt }],
        ...(mode === "email" ? { response_format: { type: "json_object" } } : {}),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ProviderError("groq", "unavailable", `Groq could not be reached: ${errorMessage(err)}`);
  }

  const raw = await res.text();
  if (!res.ok) {
    throw new ProviderError("groq", classify(res.status, raw), `Groq returned HTTP ${res.status}`, res.status, raw.slice(0, 1000));
  }
  let content: string | undefined;
  try {
    content = (JSON.parse(raw) as { choices?: { message?: { content?: string } }[] }).choices?.[0]?.message?.content;
  } catch {
    throw new ProviderError("groq", "bad_response", "Groq response was not valid JSON", res.status, raw.slice(0, 500));
  }
  if (!content) throw new ProviderError("groq", "bad_response", "Groq returned an empty response", res.status, raw.slice(0, 500));
  return content;
}

function failureDetails(err: ProviderError, ctx: LlmContext, attempt: number, maxAttempts: number) {
  return {
    provider: err.provider,
    model: err.provider === "gemini" ? env.geminiModel : env.groqModel,
    httpStatus: err.httpStatus ?? null,
    providerBody: err.providerBody ?? null,
    attempt,
    maxAttempts,
    ...ctx,
  };
}

const PROVIDER_NAME: Record<GenerationProvider, string> = { gemini: "Gemini", groq: "Groq" };

// Runs one provider with retry/backoff on transient failures. Every failed
// attempt is logged as a warning; the caller decides whether the final
// failure is an error or a reason to fall back.
async function withRetries(
  provider: GenerationProvider,
  run: () => Promise<string>,
  ctx: LlmContext
): Promise<string> {
  let last: ProviderError | null = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await run();
    } catch (err) {
      last = err instanceof ProviderError ? err : new ProviderError(provider, "other", errorMessage(err));
      const willRetry = attempt < MAX_ATTEMPTS && retryable(last.kind);
      if (willRetry) {
        await logWarning("generation", `${provider.toUpperCase()}_${KIND_CODE[last.kind]}`, `${PROVIDER_NAME[provider]} request failed, retrying: ${last.message}`, {
          details: failureDetails(last, ctx, attempt, MAX_ATTEMPTS),
        });
        await sleep(BACKOFF_MS[attempt - 1] ?? 3000);
        continue;
      }
      throw Object.assign(last, { attempt });
    }
  }
  throw last;
}

const groqConfigured = () => Boolean(env.groqApiKey && env.groqModel);

async function complete(prompt: string, mode: "email" | "text", ctx: LlmContext): Promise<{ text: string; provider: GenerationProvider }> {
  const geminiCoolingDown = Date.now() < geminiCooldownUntil;

  if (geminiCoolingDown && groqConfigured()) {
    try {
      return { text: await withRetries("groq", () => callGroq(prompt, mode), ctx), provider: "groq" };
    } catch (err) {
      const groqErr = err as ProviderError & { attempt?: number };
      await logWarning("generation", `GROQ_${KIND_CODE[groqErr.kind]}`, `Groq failed during the Gemini cooldown, retrying on Gemini: ${groqErr.message}`, {
        details: failureDetails(groqErr, ctx, groqErr.attempt ?? MAX_ATTEMPTS, MAX_ATTEMPTS),
      });
    }
  }

  let geminiErr: ProviderError & { attempt?: number };
  try {
    const text = await withRetries("gemini", () => callGemini(prompt, mode), ctx);
    geminiCooldownUntil = 0;
    return { text, provider: "gemini" };
  } catch (err) {
    geminiErr = err as ProviderError & { attempt?: number };
  }

  const geminiCode = `GEMINI_${KIND_CODE[geminiErr.kind]}`;
  const geminiDetails = failureDetails(geminiErr, ctx, geminiErr.attempt ?? MAX_ATTEMPTS, MAX_ATTEMPTS);

  if (!fallbackEligible(geminiErr.kind)) {
    await logError("generation", geminiCode, `Gemini request failed: ${geminiErr.message}`, { error: geminiErr, details: geminiDetails });
    throw alreadyLogged(new ExternalServiceError("gemini", `Gemini request failed: ${geminiErr.message}`, geminiErr));
  }

  geminiCooldownUntil = Date.now() + GEMINI_COOLDOWN_MS;

  if (!groqConfigured()) {
    await logWarning("generation", "GROQ_NOT_CONFIGURED", "Gemini is rate limited or unavailable and no Groq fallback is configured (set GROQ_API_KEY and GROQ_MODEL)", {
      details: geminiDetails,
    });
    await logError("generation", geminiCode, `Gemini request failed: ${geminiErr.message}`, { error: geminiErr, details: geminiDetails });
    throw alreadyLogged(new ExternalServiceError("gemini", `Gemini request failed: ${geminiErr.message}`, geminiErr));
  }

  await logWarning("generation", "GENERATION_FALLBACK_TO_GROQ", `Gemini ${geminiErr.kind === "rate_limit" ? "is rate limited" : "is unavailable"}; switching to Groq for the next ${GEMINI_COOLDOWN_MS / 60000} minutes`, {
    details: geminiDetails,
  });

  try {
    return { text: await withRetries("groq", () => callGroq(prompt, mode), ctx), provider: "groq" };
  } catch (err) {
    const groqErr = err as ProviderError & { attempt?: number };
    const message = `Both providers failed. Gemini: ${geminiErr.message}. Groq: ${groqErr.message}`;
    await logError("generation", "GENERATION_ALL_PROVIDERS_FAILED", message, {
      error: groqErr,
      details: { gemini: geminiDetails, groq: failureDetails(groqErr, ctx, groqErr.attempt ?? MAX_ATTEMPTS, MAX_ATTEMPTS) },
    });
    throw alreadyLogged(new ExternalServiceError("groq", message, groqErr));
  }
}

// Bad JSON from a model is a transient quirk, not a provider outage: one
// fresh call is worth it before giving up on the contact.
export async function completeEmailJson(prompt: string, ctx: LlmContext): Promise<EmailJson & { provider: GenerationProvider }> {
  for (let attempt = 1; ; attempt++) {
    const { text, provider } = await complete(prompt, "email", ctx);
    try {
      return { ...parseEmailJson(provider, text), provider };
    } catch (err) {
      const parseErr = err as ProviderError;
      if (attempt >= 2) {
        await logError("generation", `${provider.toUpperCase()}_BAD_RESPONSE`, parseErr.message, {
          details: failureDetails(parseErr, ctx, attempt, 2),
        });
        throw alreadyLogged(new ExternalServiceError(provider, parseErr.message, parseErr));
      }
      await logWarning("generation", `${provider.toUpperCase()}_BAD_RESPONSE`, `${parseErr.message}; retrying once`, {
        details: failureDetails(parseErr, ctx, attempt, 2),
      });
    }
  }
}

export async function completeText(prompt: string, ctx: LlmContext): Promise<{ text: string; provider: GenerationProvider }> {
  return complete(prompt, "text", ctx);
}
