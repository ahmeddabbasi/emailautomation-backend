export class ExternalServiceError extends Error {
  // Set when the failure was already written to Error Logs with full
  // provider detail, so route-level handling doesn't log it a second time.
  public logged = false;

  constructor(
    public readonly service: "supabase" | "gemini" | "groq" | "mailgun",
    message: string,
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "ExternalServiceError";
  }
}

export function alreadyLogged(err: ExternalServiceError): ExternalServiceError {
  err.logged = true;
  return err;
}

export class ValidationFailedError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = "ValidationFailedError";
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  // supabase-js PostgrestError and similar are plain objects with a
  // `.message` string, not Error instances — String(err) on those gives
  // the useless "[object Object]" instead of the actual message.
  if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
    return err.message;
  }
  return String(err);
}
