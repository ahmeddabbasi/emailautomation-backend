import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createMailbox, listMailboxes } from "@/lib/mailboxes";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const schema = z.object({
  displayName: z.string().min(1),
  email: z.string().email(),
  smtpHost: z.string().min(1),
  smtpPort: z.number().int().positive(),
  smtpSecurity: z.enum(["ssl", "starttls"]),
  username: z.string().min(1),
  password: z.string().min(1),
  imapHost: z.string().nullable().optional(),
  imapPort: z.number().int().positive().nullable().optional(),
  replyTo: z.string().nullable().optional(),
  signatureHtml: z.string().optional(),
  dailyLimit: z.number().int(),
  hourlyLimit: z.number().int(),
});

export async function GET() {
  try {
    return NextResponse.json({ mailboxes: await listMailboxes() });
  } catch (err) {
    return handleRouteError(err, "settings");
  }
}

export async function POST(request: NextRequest) {
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return jsonError(400, "Invalid mailbox", { issues: parsed.error.issues });
    const mailbox = await createMailbox(parsed.data);
    return NextResponse.json({ mailbox }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create mailbox";
    if (/limit|required|email/i.test(message)) return jsonError(400, message);
    return handleRouteError(err, "settings");
  }
}
