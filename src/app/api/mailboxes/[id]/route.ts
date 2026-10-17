import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { deleteMailbox, updateMailbox } from "@/lib/mailboxes";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const schema = z.object({
  displayName: z.string().min(1).optional(),
  email: z.string().email().optional(),
  smtpHost: z.string().min(1).optional(),
  smtpPort: z.number().int().positive().optional(),
  smtpSecurity: z.enum(["ssl", "starttls"]).optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1).optional(),
  imapHost: z.string().nullable().optional(),
  imapPort: z.number().int().positive().nullable().optional(),
  replyTo: z.string().nullable().optional(),
  signatureHtml: z.string().optional(),
  dailyLimit: z.number().int().optional(),
  hourlyLimit: z.number().int().optional(),
  status: z.enum(["paused"]).optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return jsonError(400, "Invalid mailbox", { issues: parsed.error.issues });
    const mailbox = await updateMailbox(id, parsed.data);
    return NextResponse.json({ mailbox });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update mailbox";
    if (/limit|Test connection|not found/i.test(message)) return jsonError(400, message);
    return handleRouteError(err, "settings");
  }
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await deleteMailbox(id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return handleRouteError(err, "settings");
  }
}
