import { supabaseAdmin } from "@/lib/supabase/server";
import { errorMessage } from "@/lib/errors";
import type { CampaignContactStatus } from "@/lib/supabase/db-types";

// generation_failed is included because it isn't terminal — a Retry would
// put the contact back into the sequence and email an address that has
// bounced, complained, or already replied.
const HALTABLE_STATUSES: CampaignContactStatus[] = ["pending", "queued", "generation_failed"];

export async function haltActiveEnrollmentsByEmail(
  email: string,
  status: Extract<CampaignContactStatus, "invalid" | "complained" | "replied" | "unsubscribed">
): Promise<string[]> {
  const db = supabaseAdmin();
  const { data: contact } = await db.from("contacts").select("id").eq("email", email.trim().toLowerCase()).maybeSingle();
  if (!contact) return [];

  const { data: rows, error } = await db
    .from("campaign_contacts")
    .update({ status, locked_at: null })
    .eq("contact_id", contact.id)
    .in("status", HALTABLE_STATUSES)
    .select("id");
  if (error) throw new Error(`Failed to halt enrollments for ${email}: ${errorMessage(error)}`);
  return (rows ?? []).map((r) => r.id);
}

function extractMessageIds(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.match(/<[^>]+>/g) ?? [];
}

// We store Mailgun's id as returned by messages.create ("<id@domain>");
// event payloads carry the bare header value ("id@domain").
function bracketed(messageId: string): string {
  const bare = messageId.trim().replace(/^<|>$/g, "");
  return `<${bare}>`;
}

export interface InboundReplyParams {
  sender: string;
  subject: string | null;
  bodyPlain: string | null;
  inReplyTo: string | null;
  references: string | null;
}

// Matches the reply to a specific prior send via In-Reply-To/References
// headers against our stored provider_message_id first (precise); falls
// back to "most recent active enrollment for this sender" if headers are
// missing or stripped. Either way, halting the sender's outreach entirely
// is the safe default — better to stop too broadly than email someone who
// just replied.
export async function handleInboundReply(params: InboundReplyParams): Promise<{
  matched: boolean;
  campaignContactId: string | null;
}> {
  const db = supabaseAdmin();
  const candidateIds = [...extractMessageIds(params.inReplyTo), ...extractMessageIds(params.references)];

  let campaignContactId: string | null = null;

  if (candidateIds.length > 0) {
    const { data } = await db
      .from("sends")
      .select("campaign_contact_id")
      .in("provider_message_id", candidateIds)
      .not("campaign_contact_id", "is", null)
      .limit(1)
      .maybeSingle();
    if (data?.campaign_contact_id) campaignContactId = data.campaign_contact_id;
  }

  if (!campaignContactId) {
    const { data: contact } = await db
      .from("contacts")
      .select("id")
      .eq("email", params.sender.toLowerCase())
      .maybeSingle();
    if (contact) {
      const { data: cc } = await db
        .from("campaign_contacts")
        .select("id")
        .eq("contact_id", contact.id)
        .in("status", HALTABLE_STATUSES)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cc) campaignContactId = cc.id;
    }
  }

  await haltActiveEnrollmentsByEmail(params.sender, "replied");

  if (campaignContactId) {
    await db.from("replies").insert({
      campaign_contact_id: campaignContactId,
      subject: params.subject,
      body_snippet: (params.bodyPlain ?? "").slice(0, 500),
    });
  }

  return { matched: campaignContactId !== null, campaignContactId };
}

export interface BounceParams {
  recipient: string;
  messageId: string | null;
  reason: string | null;
}

export async function handleBounce(params: BounceParams): Promise<{ halted: string[]; sendFlagged: boolean }> {
  const halted = await haltActiveEnrollmentsByEmail(params.recipient, "invalid");
  if (!params.messageId) return { halted, sendFlagged: false };

  const db = supabaseAdmin();
  const { data, error } = await db
    .from("sends")
    .update({
      delivery_failed_at: new Date().toISOString(),
      error_message: `Bounced after acceptance: ${params.reason ?? "permanent failure"}`,
    })
    .eq("provider_message_id", bracketed(params.messageId))
    .eq("status", "sent")
    .is("delivery_failed_at", null)
    .select("id");
  if (error) throw new Error(`Failed to flag bounced send ${params.messageId}: ${errorMessage(error)}`);
  return { halted, sendFlagged: (data?.length ?? 0) > 0 };
}

export async function handleComplaint(recipient: string): Promise<string[]> {
  return haltActiveEnrollmentsByEmail(recipient, "complained");
}
