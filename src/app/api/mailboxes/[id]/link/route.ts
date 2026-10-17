import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { linkMailbox, listMailboxes } from "@/lib/mailboxes";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

const schema = z.object({ campaignId: z.string().uuid().nullable() });

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return jsonError(400, "campaignId must be a campaign id or null");
    await linkMailbox(id, parsed.data.campaignId);
    const mailbox = (await listMailboxes()).find((item) => item.id === id) ?? null;
    return NextResponse.json({ mailbox });
  } catch (err) {
    return handleRouteError(err, "settings");
  }
}
