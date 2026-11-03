import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";
import { getKnowledgeOverview } from "@/lib/knowledge";
import { isPlaceholderLink } from "@/lib/links";

export interface GuideAction {
  title: string;
  detail: string;
  href: string;
  label: string;
}

export interface GuideStep {
  id: string;
  title: string;
  detail: string;
  href: string;
  state: "done" | "now" | "later";
}

export interface GuideTip {
  title: string;
  detail: string;
}

export interface GuidePayload {
  readyToSend: boolean;
  headline: string;
  next: GuideAction | null;
  steps: GuideStep[];
  tips: GuideTip[];
}

interface ListRow {
  id: string;
  name: string;
  status: string;
  sender_name: string;
  raw_subject_structure: string;
  raw_email_structure: string;
  cta_link: string;
  generation_status: string;
  generation_completed: number;
  generation_total: number;
  generation_failed_count: number;
  test_mode: boolean;
  daily_cap: number;
}

interface CampaignRow {
  id: string;
  name: string;
  status: string;
  company_description: string;
  value_props: string;
  lead_lists: ListRow[] | null;
}

function listHref(campaignId: string, listId: string): string {
  return `/campaigns/${campaignId}/lead-lists/${listId}`;
}

export async function buildGuide(): Promise<GuidePayload> {
  const db = supabaseAdmin();
  const [mailboxResult, settingsResult, knowledge, campaignResult, staleDrafts] = await Promise.all([
    db.from("mailboxes").select("id, display_name, email, status, campaign_id, last_error"),
    db.from("app_settings").select("default_cta_link").eq("id", true).maybeSingle(),
    getKnowledgeOverview(),
    db
      .from("campaigns")
      .select(
        "id, name, status, company_description, value_props, lead_lists(id, name, status, sender_name, raw_subject_structure, raw_email_structure, cta_link, generation_status, generation_completed, generation_total, generation_failed_count, test_mode, daily_cap)"
      )
      .order("created_at", { ascending: false }),
    db.from("campaign_contacts").select("lead_list_id").ilike("initial_body", "%example.com%"),
  ]);
  if (mailboxResult.error) throw new Error(mailboxResult.error.message);
  if (settingsResult.error) throw new Error(settingsResult.error.message);
  if (campaignResult.error) throw new Error(campaignResult.error.message);
  if (staleDrafts.error) throw new Error(staleDrafts.error.message);

  const mailboxes = mailboxResult.data ?? [];
  const campaigns = (campaignResult.data ?? []) as unknown as CampaignRow[];
  const lists = campaigns.flatMap((campaign) => (campaign.lead_lists ?? []).map((list) => ({ campaign, list })));
  const activeMailboxes = mailboxes.filter((mailbox) => mailbox.status === "active");
  const linked = activeMailboxes.filter((mailbox) => mailbox.campaign_id);
  const defaultLink = settingsResult.data?.default_cta_link ?? "";
  const staleListIds = new Set((staleDrafts.data ?? []).map((row) => row.lead_list_id as string));
  const badLists = lists.filter(({ list }) => isPlaceholderLink(list.cta_link) || staleListIds.has(list.id));
  const factsReady = Boolean(knowledge.facts.trim() || knowledge.enabledSources > 0 || knowledge.brief);
  const briefReady = campaigns.some((campaign) => campaign.company_description.trim() && campaign.value_props.trim());
  const shaped = lists.filter(
    ({ list }) => list.sender_name.trim() && list.raw_subject_structure.trim() && list.raw_email_structure.trim()
  );
  const generated = lists.filter(
    ({ list }) => list.generation_total > 0 && list.generation_status === "completed" && list.generation_failed_count === 0
  );
  const testLists = lists.filter(({ list }) => list.test_mode);
  const activeWhileUnsafe = campaigns.some((campaign) => campaign.status === "active");

  const firstBad = badLists[0];
  const firstCampaign = campaigns[0];
  const firstUnshaped = lists.find(({ list }) => !list.sender_name.trim() || !list.raw_subject_structure.trim() || !list.raw_email_structure.trim());
  const firstUngenerated = lists.find(
    ({ list }) => list.generation_total === 0 || list.generation_status !== "completed" || list.generation_failed_count > 0
  );

  const draft: Omit<GuideStep, "state">[] = [
    {
      id: "mailbox",
      title: "Connect a Zoho mailbox",
      detail: activeMailboxes.length
        ? `${activeMailboxes.length} active mailbox${activeMailboxes.length === 1 ? "" : "es"}. A paused or failed row is ignored.`
        : "Settings, Mailboxes. Use the Zoho app password, SSL on port 465, then Test connection. Keep the daily limit at 30 or below. A new mailbox should start at 10 to 15 a day.",
      href: "/settings",
    },
    {
      id: "link",
      title: "Link that mailbox to the campaign",
      detail: linked.length
        ? "Linked. That campaign sends only through this mailbox."
        : "On the mailbox row, choose the campaign. With no link, those emails do not go through Zoho.",
      href: "/settings",
    },
    {
      id: "link-real",
      title: "Use a real link, or none",
      detail: firstBad
        ? isPlaceholderLink(firstBad.list.cta_link)
          ? `${firstBad.list.name} still has ${firstBad.list.cta_link}. Replace it, save, then run generation again. Drafts already written keep the old link until you do.`
          : `${firstBad.list.name} has drafts that still contain example.com. Clear the link, save, then run generation again.`
        : isPlaceholderLink(defaultLink)
          ? `Settings still offers ${defaultLink} to every new list. Put your real page there, or clear it. A blank link means the email has no link.`
          : "No placeholder link is stored. Leave the field blank when the email should not include one.",
      href: firstBad ? listHref(firstBad.campaign.id, firstBad.list.id) : "/settings",
    },
    {
      id: "facts",
      title: "Add company facts",
      detail: factsReady
        ? "The writer can use what is saved under Settings."
        : "Settings, Company facts. Write only claims the emails are allowed to make. With this empty, the writer has the campaign description and the list brief, and the note stays generic.",
      href: "/settings",
    },
    {
      id: "brief",
      title: "Describe the company on the campaign",
      detail: briefReady
        ? "A campaign has a description and value props."
        : "Campaigns, New campaign. One plain description, then one benefit per line. Save before you leave the page.",
      href: firstCampaign && !(firstCampaign.company_description.trim() && firstCampaign.value_props.trim())
        ? `/campaigns/${firstCampaign.id}`
        : "/campaigns/new",
    },
    {
      id: "shape",
      title: "Set the list brief",
      detail: shaped.length
        ? "Sender name, subject structure, and email structure are set. The schedule is already weekdays, 9:00 to 18:00 in the list timezone, 20 a day, in bursts of 5."
        : "Open the list. Sender name is required. Each [bracket] in the email structure becomes one paragraph. Follow-ups are already 3, 7, and 14 days.",
      href: firstUnshaped ? listHref(firstUnshaped.campaign.id, firstUnshaped.list.id) : firstCampaign ? `/campaigns/${firstCampaign.id}` : "/campaigns/new",
    },
    {
      id: "people",
      title: "Import people and wait for generation",
      detail: generated.length
        ? "Drafts are complete on a list."
        : firstUngenerated && firstUngenerated.list.generation_failed_count > 0
          ? `${firstUngenerated.list.generation_failed_count} drafts failed. Fix the brief, then retry failed on that list.`
          : "Upload the CSV, map Email, then wait until the list says Generation complete. People are not ready to send before that.",
      href: firstUngenerated ? listHref(firstUngenerated.campaign.id, firstUngenerated.list.id) : firstCampaign ? `/campaigns/${firstCampaign.id}` : "/campaigns",
    },
  ];

  const checks = [
    activeMailboxes.length > 0,
    linked.length > 0,
    badLists.length === 0 && !isPlaceholderLink(defaultLink),
    factsReady,
    briefReady,
    shaped.length > 0,
    generated.length > 0 && lists.every(({ list }) => list.generation_total === 0 || (list.generation_status === "completed" && list.generation_failed_count === 0)),
  ];
  const readyToSend = checks.every(Boolean) && testLists.length === 0;
  const firstOpen = checks.findIndex((ok) => !ok);

  const launchDetail = readyToSend
    ? activeWhileUnsafe
      ? "The checks are done. Sending follows each list window. Run campaign only when you want the next due batch immediately."
      : "The checks are done. Resume the campaign when you want the next window to send."
    : testLists.length
      ? `${testLists[0].list.name} is in test mode. That sends real email, on a 5, 10, and 15 minute clock, to whoever is on the list. Turn it off before any real leads.`
      : activeWhileUnsafe
        ? "A campaign is still active while a step above is open. Pause it. Resume only when every step is done."
        : "Leave the campaign paused until every step above is done. Resume sends on the list's next window.";

  const launchHref = testLists[0]
    ? listHref(testLists[0].campaign.id, testLists[0].list.id)
    : firstCampaign
      ? `/campaigns/${firstCampaign.id}`
      : "/campaigns";

  const all = [
    ...draft,
    {
      id: "launch",
      title: readyToSend ? "Ready to send" : "Keep it paused until the steps are done",
      detail: launchDetail,
      href: launchHref,
    },
  ];

  const nowIndex = firstOpen === -1 ? all.length - 1 : firstOpen;
  const steps: GuideStep[] = all.map((step, index) => ({
    ...step,
    state: index < nowIndex ? "done" : index === nowIndex ? "now" : "later",
  }));
  const current = steps[nowIndex];

  const tips: GuideTip[] = [
    {
      title: "Shape of the first email",
      detail: "One sentence about their company, one about how you help, then one ask. Short paragraphs. No image and no extra links on a cold first note.",
    },
    {
      title: "Leave the HTML template empty",
      detail: "The template boxes start blank on purpose. Saving text there sends those exact words instead of the AI draft. Use it only when the wording must not change.",
    },
    {
      title: "What is already set for you",
      detail: "New lists start on weekdays, 9:00 to 18:00 in the list timezone, 20 emails a day, bursts of 5 with 180 minutes between them, and follow-ups at 3, 7, and 14 days. Test mode stays off.",
    },
  ];
  if (lists.some(({ list }) => list.daily_cap > 15)) {
    tips.push({
      title: "Start a new mailbox slower",
      detail: "A list cap of 20 is fine later. For the first weeks, 10 to 15 a day lands in the inbox more often than a full cap.",
    });
  }

  return {
    readyToSend,
    headline: current?.title ?? "Ready to send",
    next: current
      ? { title: current.title, detail: current.detail, href: current.href, label: readyToSend ? "Open campaign" : "Do this step" }
      : null,
    steps,
    tips,
  };
}
