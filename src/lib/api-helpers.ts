import { NextResponse } from "next/server";
import { ExternalServiceError, ValidationFailedError, errorMessage } from "@/lib/errors";
import { logError, logWarning, type LogSource } from "@/lib/logger";

// A 400 carrying zod `issues` means our own UI sent a payload the API
// rejected, which is a bug worth seeing in Error Logs. Other 4xx responses
// are expected outcomes (not found, wrong password) logged at their call
// sites with a specific code where they matter.
export function jsonError(status: number, message: string, extra?: Record<string, unknown>) {
  if (status === 400 && extra?.issues) {
    logWarning("api", "API_INVALID_PAYLOAD", message, { details: { httpStatus: status, issues: extra.issues } });
  }
  return NextResponse.json({ error: message, ...extra }, { status });
}

const SERVICE_CODES: Record<ExternalServiceError["service"], string> = {
  supabase: "DB_QUERY_FAILED",
  gemini: "GEMINI_REQUEST_FAILED",
  groq: "GROQ_REQUEST_FAILED",
  mailgun: "MAILGUN_REQUEST_FAILED",
};

// Uniform error -> HTTP status mapping so no route ever returns a bare,
// context-free 500, and every failure lands in Error Logs.
export function handleRouteError(err: unknown, source: LogSource = "api"): NextResponse {
  if (err instanceof ExternalServiceError) {
    if (!err.logged) logError(source, SERVICE_CODES[err.service], err.message, { error: err, details: { httpStatus: 502 } });
    return jsonError(502, err.message, { service: err.service });
  }
  if (err instanceof ValidationFailedError) {
    logWarning(source, "VALIDATION_FAILED", err.message, { details: { httpStatus: 422 } });
    return jsonError(422, err.message);
  }
  if (err instanceof Error && /^Missing required environment variable/.test(err.message)) {
    logError(source, "CONFIG_MISSING_ENV", err.message, { error: err, details: { httpStatus: 500 } });
    return jsonError(500, "Server is misconfigured: a required environment variable is missing.");
  }
  logError(source, "UNHANDLED_API_ERROR", errorMessage(err), { error: err, details: { httpStatus: 500 } });
  return jsonError(500, errorMessage(err));
}
