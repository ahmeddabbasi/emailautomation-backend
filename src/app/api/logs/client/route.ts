import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { logEvent } from "@/lib/logger";

const schema = z.object({
  code: z.string().min(1).max(80),
  message: z.string().min(1).max(2000),
  level: z.enum(["error", "warning"]).default("error"),
  details: z.record(z.string(), z.unknown()).optional(),
  stack: z.string().max(8000).optional(),
});

// Browser-side errors and failed API calls, reported by lib/client-log.
// Session-protected by the proxy like every other API route. It answers
// 204 even for a malformed report: a client that can't describe its own
// error shouldn't get an error back to report in a loop.
export async function POST(request: NextRequest) {
  const parsed = schema.safeParse(await request.json().catch(() => null));
  if (parsed.success) {
    const { code, message, level, details, stack } = parsed.data;
    const error = stack ? Object.assign(new Error(message), { stack }) : undefined;
    await logEvent({
      level,
      source: "client",
      code: code.toUpperCase().replace(/[^A-Z0-9_]/g, "_"),
      message,
      error,
      details: { ...details, userAgent: request.headers.get("user-agent") },
    });
  }
  return new NextResponse(null, { status: 204 });
}
