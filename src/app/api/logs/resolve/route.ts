import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { setResolved } from "@/lib/error-logs";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const schema = z
  .object({
    ids: z.array(z.string().uuid()).max(500).optional(),
    fingerprints: z.array(z.string().min(1)).max(500).optional(),
    resolved: z.boolean().default(true),
  })
  .refine((v) => (v.ids?.length ?? 0) + (v.fingerprints?.length ?? 0) > 0, "Nothing selected");

export async function POST(request: NextRequest) {
  try {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError(400, "Invalid resolve payload", { issues: parsed.error.issues });
    const updated = await setResolved(parsed.data, parsed.data.resolved);
    return NextResponse.json({ updated });
  } catch (err) {
    return handleRouteError(err, "api");
  }
}
