import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { updateContactStatus } from "@/lib/queries";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const patchSchema = z.object({
  status: z.enum(["stopped", "invalid", "pending", "queued"]),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) return jsonError(400, "status must be one of: stopped, invalid, pending, queued");

    const updated = await updateContactStatus(id, parsed.data.status);
    if (!updated) return jsonError(409, `Contact not found, or can't move to '${parsed.data.status}' from its current status`);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleRouteError(err);
  }
}
