import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { testMailbox } from "@/lib/mailboxes";
import { jsonError } from "@/lib/api-helpers";

const schema = z.object({ to: z.string().email().optional() });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const parsed = schema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return jsonError(400, "Test recipient must be an email address");
    const mailbox = await testMailbox(id, parsed.data.to);
    return NextResponse.json({ mailbox });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection test failed";
    return jsonError(400, message);
  }
}
