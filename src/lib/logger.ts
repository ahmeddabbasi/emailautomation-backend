import "server-only";
import { createHash } from "node:crypto";
import { after } from "next/server";
import { headers } from "next/headers";
import { supabaseAdmin } from "@/lib/supabase/server";
import { ExternalServiceError } from "@/lib/errors";

export type LogLevel = "error" | "warning";
export type LogSource =
  | "generation"
  | "sending"
  | "dispatch"
  | "cron"
  | "webhook"
  | "ingestion"
  | "auth"
  | "analytics"
  | "settings"
  | "knowledge"
  | "api"
  | "client";

export const LOG_SOURCES: LogSource[] = [
  "generation",
  "sending",
  "dispatch",
  "cron",
  "webhook",
  "ingestion",
  "auth",
  "analytics",
  "settings",
  "knowledge",
  "api",
  "client",
];

export interface LogEntry {
  level: LogLevel;
  source: LogSource;
  code: string;
  message: string;
  details?: Record<string, unknown>;
  error?: unknown;
}

const RETENTION_DAYS = 30;
const MAX_STRING = 8000;
const SENSITIVE_KEY = /(api[-_]?key|secret|token|password|passwd|authorization|cookie|signature|signing[-_]?key|session)/i;
const SECRET_ENV_VARS = [
  "MAILGUN_API_KEY",
  "MAILGUN_WEBHOOK_SIGNING_KEY",
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "AUTH_PASSWORD",
  "AUTH_SECRET",
  "CRON_SECRET",
];

function secretValues(): string[] {
  return SECRET_ENV_VARS.map((name) => process.env[name]).filter((v): v is string => Boolean(v && v.length >= 6));
}

// Strips anything that looks like a credential out of free text: known
// secret env values verbatim, plus the common shapes keys travel in (query
// strings, bearer headers, basic auth, JWTs).
export function redactText(text: string): string {
  let out = text;
  for (const secret of secretValues()) out = out.split(secret).join("[REDACTED]");
  return out
    .replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"']+/gi, "$1[REDACTED]")
    .replace(/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/g, "$1 [REDACTED]")
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]")
    .slice(0, MAX_STRING);
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? "[REDACTED]" : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

// Pulls what's useful for diagnosis off whatever was thrown: provider SDK
// errors carry an HTTP status and a response body in different places.
function describeError(err: unknown): { details: Record<string, unknown>; stack?: string } {
  if (!err || typeof err !== "object") return { details: err === undefined ? {} : { thrown: String(err) } };
  const e = err as Record<string, unknown> & { stack?: string; message?: string; cause?: unknown };
  const response = e.response as { status?: number } | undefined;
  const details: Record<string, unknown> = {};
  const status = e.status ?? e.statusCode ?? response?.status;
  if (status !== undefined) details.httpStatus = status;
  if (err instanceof ExternalServiceError) details.provider = err.service;
  if (e.message) details.errorMessage = e.message;
  for (const key of ["details", "body", "code", "type"] as const) {
    if (e[key] !== undefined && typeof e[key] !== "function") details[`provider_${key}`] = e[key];
  }
  if (e.cause && e.cause !== err) details.cause = describeError(e.cause).details;
  const causeStack = (e.cause as { stack?: string } | undefined)?.stack;
  return { details, stack: e.stack ?? causeStack };
}

async function requestContext(): Promise<Record<string, unknown>> {
  try {
    const h = await headers();
    const path = h.get("x-request-path");
    const method = h.get("x-request-method");
    return path ? { requestPath: path, requestMethod: method } : {};
  } catch {
    return {};
  }
}

export function fingerprint(code: string, message: string): string {
  return createHash("md5").update(`${code}|${message}`).digest("hex");
}

async function write(entry: LogEntry, context: Record<string, unknown>): Promise<void> {
  let message = entry.message;
  let details: Record<string, unknown> = {};
  let stack: string | null = null;
  try {
    const described = entry.error === undefined ? { details: {} } : describeError(entry.error);
    message = redactText(entry.message);
    details = redactValue({ ...context, ...described.details, ...entry.details }) as Record<string, unknown>;
    stack = described.stack ? redactText(described.stack) : null;

    const consoleFn = entry.level === "error" ? console.error : console.warn;
    consoleFn(`[${entry.source}] ${entry.code}: ${message}`);

    const { error } = await supabaseAdmin().from("error_logs").insert({
      level: entry.level,
      source: entry.source,
      code: entry.code,
      message,
      details,
      stack,
      fingerprint: fingerprint(entry.code, message),
    });
    if (error) console.error(`[logger] failed to persist ${entry.code}: ${error.message}`, details);
  } catch (err) {
    console.error(`[logger] failed to persist ${entry.code}`, err, details);
  }
}

// Never throws and never blocks the caller's response: inside a request the
// write is scheduled with next/server `after` (registered synchronously,
// while the request is still live) and runs once the response is sent.
// Outside a request scope `after` throws, so the write happens directly.
export function logEvent(entry: LogEntry): Promise<void> {
  try {
    after(async () => write(entry, await requestContext()));
    return Promise.resolve();
  } catch {
    return write(entry, {}).catch((err) => console.error(`[logger] ${entry.code}: ${entry.message}`, err));
  }
}

export function logError(source: LogSource, code: string, message: string, opts: Omit<LogEntry, "level" | "source" | "code" | "message"> = {}) {
  return logEvent({ level: "error", source, code, message, ...opts });
}

export function logWarning(source: LogSource, code: string, message: string, opts: Omit<LogEntry, "level" | "source" | "code" | "message"> = {}) {
  return logEvent({ level: "warning", source, code, message, ...opts });
}

export async function purgeOldErrorLogs(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
  const { error } = await supabaseAdmin().from("error_logs").delete().lt("created_at", cutoff);
  if (error) await logError("cron", "ERROR_LOG_PURGE_FAILED", `Failed to purge error logs older than ${RETENTION_DAYS} days`, { error });
}
