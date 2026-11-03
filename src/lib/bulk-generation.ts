import { supabaseAdmin } from "@/lib/supabase/server";
import { generateEmail, validateGeneratedEmail, resolveSenderIdentity } from "@/lib/generation";
import { errorMessage } from "@/lib/errors";
import { logError, logWarning } from "@/lib/logger";
import type { CampaignContactRow, CampaignRow, ContactRow, LeadListRow } from "@/lib/supabase/db-types";

const CONCURRENCY = 5;
const DEFAULT_BATCH_SIZE = 10;

export interface GenerationBatchResult {
  processed: number;
  succeeded: number;
  failed: number;
  done: boolean;
  remaining: number;
}

type QueuedRow = CampaignContactRow & { contacts: ContactRow };

// Processes one small batch of a lead list's ungenerated initial drafts and
// persists results immediately, so the job is resumable: calling this again
// only ever picks up rows still missing initial_subject — re-triggering
// after a crash or a closed tab never regenerates (and re-bills) work
// that already succeeded.
export async function processGenerationBatch(
  leadListId: string,
  batchSize = DEFAULT_BATCH_SIZE
): Promise<GenerationBatchResult> {
  const db = supabaseAdmin();

  const { data: listRow, error: listErr } = await db
    .from("lead_lists")
    .select("*, campaigns(*)")
    .eq("id", leadListId)
    .maybeSingle();
  if (listErr) throw new Error(`Failed to load lead list: ${errorMessage(listErr)}`);
  if (!listRow) throw new Error(`Lead list ${leadListId} not found`);

  const joined = listRow as unknown as LeadListRow & { campaigns: CampaignRow | CampaignRow[] | null };
  const { campaigns: campaignRelation, ...list } = joined;
  const campaign = Array.isArray(campaignRelation) ? campaignRelation[0] : campaignRelation;
  if (!campaign) throw new Error("Attach this list to a campaign before generating.");

  if (list.generation_status === "pending") {
    await db.from("lead_lists").update({ generation_status: "running" }).eq("id", leadListId);
  }

  const { data: rows, error } = await db
    .from("campaign_contacts")
    .select("*, contacts!inner(*)")
    .eq("lead_list_id", leadListId)
    .eq("status", "queued")
    .is("initial_subject", null)
    .order("created_at", { ascending: true })
    .limit(batchSize);
  if (error) throw new Error(`Failed to load queued contacts: ${errorMessage(error)}`);

  const queued = (rows ?? []) as unknown as QueuedRow[];
  let succeeded = 0;
  let failed = 0;

  for (let i = 0; i < queued.length; i += CONCURRENCY) {
    const chunk = queued.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(chunk.map((row) => generateOne(row, campaign, list)));
    for (const r of results) {
      if (r.status === "fulfilled" && r.value) succeeded++;
      else failed++;
    }
  }

  const { count: remaining } = await db
    .from("campaign_contacts")
    .select("id", { count: "exact", head: true })
    .eq("lead_list_id", leadListId)
    .eq("status", "queued")
    .is("initial_subject", null);

  const done = (remaining ?? 0) === 0;

  await db
    .from("lead_lists")
    .update({
      generation_completed: list.generation_completed + succeeded,
      generation_failed_count: list.generation_failed_count + failed,
      generation_status: done ? "completed" : "running",
    })
    .eq("id", leadListId);

  return { processed: queued.length, succeeded, failed, done, remaining: remaining ?? 0 };
}

async function generateOne(row: QueuedRow, campaign: CampaignRow, list: LeadListRow): Promise<boolean> {
  const db = supabaseAdmin();
  const logDetails = { campaignId: campaign.id, leadListId: list.id, contactId: row.contact_id, campaignContactId: row.id, sequenceStep: 0 };

  async function fail(errorMsg: string, draft?: { subject: string; body: string; provider: string }) {
    await db.from("campaign_contacts").update({ status: "generation_failed" }).eq("id", row.id);
    await db.from("sends").insert({
      campaign_contact_id: row.id,
      sequence_step: 0,
      subject: draft?.subject ?? null,
      body: draft?.body ?? null,
      provider: draft?.provider ?? null,
      status: "failed",
      error_message: errorMsg,
      test_mode: list.test_mode,
    });
    return false;
  }

  const sender = resolveSenderIdentity(list);
  if (!sender) {
    const message = "No sender name is configured for this list. Set one before generating.";
    await logError("generation", "GENERATION_NO_SENDER", message, { details: logDetails });
    return fail(message);
  }

  try {
    const generated = await generateEmail(row.contacts, campaign, list, 0, sender, row.id);
    const validation = validateGeneratedEmail(generated.subject, generated.body, list);

    if (!validation.pass) {
      await logWarning("generation", "GENERATION_VALIDATION_FAILED", `Generated draft failed validation: ${validation.reason}`, {
        details: { ...logDetails, provider: generated.provider, subject: generated.subject },
      });
      return fail(`Validation failed: ${validation.reason}`, generated);
    }

    const { error } = await db
      .from("campaign_contacts")
      .update({
        initial_subject: generated.subject,
        initial_body: generated.body,
        initial_provider: generated.provider,
        status: "pending",
      })
      .eq("id", row.id);
    if (error) {
      await logError("generation", "DB_QUERY_FAILED", `Failed to save a generated draft: ${errorMessage(error)}`, { error, details: logDetails });
      return false;
    }
    return true;
  } catch (err) {
    // The provider layer already logged the underlying failure in detail.
    return fail(`Generation failed: ${errorMessage(err)}`);
  }
}

// Called opportunistically from the cron tick so generation keeps moving
// even if nobody has the lead list page open: genuinely "background",
// not dependent on a browser staying on the progress screen.
export async function processStalledGeneration(maxLists = 3, batchSize = 5): Promise<void> {
  const db = supabaseAdmin();
  const { data: lists, error } = await db
    .from("lead_lists")
    .select("id, campaign_id")
    .in("generation_status", ["pending", "running"])
    .limit(maxLists);
  if (error) {
    await logError("generation", "DB_QUERY_FAILED", `Failed to find lists with pending generation: ${errorMessage(error)}`, { error });
    return;
  }

  for (const list of lists ?? []) {
    // A list with no campaign cannot be drafted. Leave it completed so the
    // next tick does not report the same missing-list failure again.
    if (!list.campaign_id) {
      await finishUnattachedList(list.id);
      continue;
    }
    try {
      await processGenerationBatch(list.id, batchSize);
    } catch (err) {
      if (unattachedList(err)) {
        await finishUnattachedList(list.id);
        continue;
      }
      await logError("generation", "BACKGROUND_GENERATION_FAILED", `Background generation batch failed: ${errorMessage(err)}`, {
        error: err,
        details: { leadListId: list.id },
      });
    }
  }
}

function unattachedList(err: unknown): boolean {
  const message = errorMessage(err);
  return /not found/i.test(message) || message === "Attach this list to a campaign before generating.";
}

async function finishUnattachedList(id: string): Promise<void> {
  const { error } = await supabaseAdmin().from("lead_lists").update({ generation_status: "completed" }).eq("id", id);
  if (error) {
    await logError("generation", "DB_QUERY_FAILED", `Failed to stop generation for a list with no campaign: ${errorMessage(error)}`, {
      error,
      details: { leadListId: id },
    });
  }
}
