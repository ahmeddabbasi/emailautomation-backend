import { env } from "@/lib/env";
import { completeEmailJson, type EmailJson, type LlmContext } from "@/lib/llm";
import { getActiveBrief, type ActiveBrief } from "@/lib/knowledge";
import { logWarning } from "@/lib/logger";
import type { SenderIdentity } from "@/lib/sending";
import type { CampaignRow, ContactRow, GenerationProvider, LeadListRow, SequenceStep } from "@/lib/supabase/db-types";

// A list's own sender_name/sender_title wins; DEFAULT_SENDER_NAME/TITLE is
// only the fallback for lists that haven't set one. Returns null when
// neither is configured — callers must block sending on null rather than
// let the model invent a name, see stripSignOff/appendSignature below.
export function resolveSenderIdentity(list: LeadListRow): SenderIdentity | null {
  const name = list.sender_name.trim() || env.defaultSenderName.trim();
  if (!name) return null;
  const title = list.sender_title.trim() || env.defaultSenderTitle.trim();
  return { name, title };
}

const SIGNOFF_WORDS = [
  "best",
  "best regards",
  "kind regards",
  "warm regards",
  "regards",
  "thanks",
  "thank you",
  "many thanks",
  "sincerely",
  "cheers",
  "talk soon",
  "best wishes",
  "yours truly",
  "yours",
];

function looksLikeSignoffLine(line: string): boolean {
  const trimmed = line.trim().replace(/[,.!]+$/, "");
  if (!trimmed) return false;
  if (SIGNOFF_WORDS.includes(trimmed.toLowerCase())) return true;
  return /^[—-]\s*\S+/.test(trimmed);
}

function isNameLikeLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  const words = trimmed.split(/\s+/);
  return words.length <= 4 && trimmed.length <= 40 && !/[.!?]$/.test(trimmed);
}

// The model is told not to write a sign-off at all, but instructions get
// ignored — this removes one deterministically instead of trusting the
// prompt, so appendSignature below never ends up stacking a real signature
// under a fake one the model invented.
export function stripSignOff(body: string): string {
  const paragraphs = body.split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1];
  if (last === undefined) return body;

  const lines = last.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return body;

  if (lines.length <= 2 && looksLikeSignoffLine(lines[0])) {
    paragraphs.pop();
    return paragraphs.join("\n\n").trimEnd();
  }

  if (lines.length >= 2) {
    const secondLast = lines[lines.length - 2];
    const lastLine = lines[lines.length - 1];
    if (looksLikeSignoffLine(secondLast) && isNameLikeLine(lastLine)) {
      const kept = lines.slice(0, lines.length - 2).join("\n");
      paragraphs[paragraphs.length - 1] = kept;
      return paragraphs.filter(Boolean).join("\n\n").trimEnd();
    }
  }

  if (looksLikeSignoffLine(lines[lines.length - 1])) {
    const kept = lines.slice(0, lines.length - 1).join("\n");
    if (kept) {
      paragraphs[paragraphs.length - 1] = kept;
      return paragraphs.filter(Boolean).join("\n\n").trimEnd();
    }
    paragraphs.pop();
    return paragraphs.join("\n\n").trimEnd();
  }

  return body;
}

// Em dashes (and spaced en dashes) are a well-known tell of AI-written text.
// The prompt forbids them; this removes any that come back anyway. Number
// ranges like "5–10" are left alone, since only spaced or em dashes match.
export function stripDashes(text: string): string {
  return text
    .replace(/([.!?:;])[ \t]*[—–][ \t]*$/gm, "$1")
    .replace(/[ \t]*—[ \t]*$/gm, ".")
    .replace(/^[ \t]*[—–][ \t]*/gm, "")
    .replace(/[ \t]*—[ \t]*/g, ", ")
    .replace(/[ \t]+–[ \t]+/g, ", ")
    .replace(/([.!?:;]), /g, "$1 ")
    .replace(/, ([.!?;:,])/g, "$1")
    .replace(/[ \t]+$/gm, "");
}

const OUTPUT_RULES = `Write in plain text with no markdown formatting and no placeholder brackets left unfilled. Never use em dashes or en dashes as punctuation; use commas, colons, or full stops instead. Do NOT write any sign-off, closing line, or name at the end of the email (no "Best,", "Thanks,", "Regards,", a dash followed by a name, or any invented name). End the body immediately after the last substantive paragraph; the sign-off is appended separately.`;

export function appendSignature(body: string, sender: SenderIdentity): string {
  const stripped = stripDashes(stripSignOff(body));
  const signature = sender.title ? `${sender.name}, ${sender.title}` : sender.name;
  return `${stripped}\n\n${signature}`;
}

const STEP_LABEL: Record<SequenceStep, string> = {
  0: "Initial outreach (Day 0). The first email this contact will receive from us.",
  1: "First follow-up. A gentle nudge; do not repeat the first email.",
  2: "Second follow-up. A new angle, not a re-pitch of the product.",
  3: "Final follow-up. The last email in the sequence.",
};

function stepGuidance(list: LeadListRow, step: SequenceStep): string {
  if (step === 0) return "This is the first email. Follow the raw structure directly.";
  if (step === 1) return list.followup_day3_guidance || "Send a brief, low-pressure nudge.";
  if (step === 2) return list.followup_day7_guidance || "Share a new angle, do not repeat prior emails.";
  return list.followup_day14_guidance || "This is the last email in the sequence; give an easy out.";
}

// Bracketed instructions like "[Open with...]" mark one required section of
// the operator's raw structure. The generated body must produce roughly one
// paragraph per bracketed section: this is the concrete signal used to
// detect structural drift (a dropped section, a reordered/merged structure)
// without relying on the model's own self-report.
function countStructureSections(structure: string): number {
  const matches = structure.match(/\[[^\]]+\]/g);
  return matches ? matches.length : 0;
}

function countParagraphs(body: string): number {
  return body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean).length;
}

const FACTS_RULE = `Only state facts about the company that appear in the company context, the company brief, the list settings, or the recipient details given here. Never invent features, prices, numbers, customers, results, or claims; if a detail is not given, leave it out. The brief may include compliance notes drawn from the Terms of Use and Privacy Policy: respect them and never promise anything they contradict, but never quote, cite, or summarise those documents in the email.`;

// A missing brief must never stop sending, so a lookup failure degrades to
// generating without it (and is logged) rather than failing the contact.
async function loadBrief(ctx: LlmContext): Promise<ActiveBrief | null> {
  try {
    return await getActiveBrief();
  } catch (err) {
    await logWarning("knowledge", "BRIEF_UNAVAILABLE", "Company brief could not be loaded; generating without it", {
      error: err,
      details: { ...ctx },
    });
    return null;
  }
}

function companyContext(campaign: CampaignRow | null, brief: ActiveBrief | null): string {
  const lines = ["COMPANY CONTEXT"];
  if (campaign) {
    lines.push(`What the company does: ${campaign.company_description || "(not provided)"}`);
    lines.push(`Key value props: ${campaign.value_props || "(not provided)"}`);
  }
  if (brief) lines.push("", `COMPANY BRIEF (verified facts, version ${brief.version})`, brief.content);
  return lines.join("\n");
}

function buildPrompt(
  contact: ContactRow,
  campaign: CampaignRow,
  list: LeadListRow,
  step: SequenceStep,
  brief: ActiveBrief | null
): string {
  return `You are writing a single cold outreach email on behalf of a company, for a specific recipient. Follow every instruction exactly.

${companyContext(campaign, brief)}

THIS LIST'S TARGETING
Industry: ${list.industry || "(not provided)"}
Target audience: ${list.target_audience || "(not provided)"}

RECIPIENT
Name: ${contact.name}
Company: ${contact.company || "(unknown)"}
Title: ${contact.title || "(unknown)"}
Known context/bio: ${contact.company_bio || "(none)"}

SEQUENCE POSITION
${STEP_LABEL[step]}
Step-specific guidance: ${stepGuidance(list, step)}

${
  list.raw_subject_structure
    ? `SUBJECT LINE STRUCTURE (follow this strictly; adapt only wording and personalization):\n${list.raw_subject_structure}\n`
    : ""
}
RAW EMAIL STRUCTURE (follow this STRICTLY). You may personalize names, company details, and the "how this helps them" section per contact, and adapt wording. You must NOT restructure, reorder, drop, or merge sections, and you must not invent a different format. Every bracketed instruction below corresponds to one paragraph in your output, in the same order:
${list.raw_email_structure || "Write a concise, direct, personalized cold email."}

REQUIRED ELEMENTS
- The CTA link must appear exactly once, verbatim: ${list.cta_link || "(no link provided)"}
- Early bird line (include only if it fits naturally for this step, do not force it into every email): "${list.early_bird_line || "(none provided)"}"
${list.other_required_elements.length > 0 ? list.other_required_elements.map((e) => `- ${e}`).join("\n") : ""}

BANNED (never use these words or phrases, in any form):
${list.banned_phrases.length > 0 ? list.banned_phrases.join(", ") : "(none specified)"}

${FACTS_RULE}

${OUTPUT_RULES} Separate each section of the body with a blank line. Return the subject line and the full email body.`;
}

export interface GeneratedEmail {
  subject: string;
  body: string;
  provider: GenerationProvider;
}

// Same post-processing whichever provider wrote the email: dashes removed,
// any invented sign-off stripped, the configured signature appended.
function finalize(raw: EmailJson & { provider: GenerationProvider }, sender: SenderIdentity): GeneratedEmail {
  return { subject: stripDashes(raw.subject).trim(), body: appendSignature(raw.body, sender), provider: raw.provider };
}

export async function generateEmail(
  contact: ContactRow,
  campaign: CampaignRow,
  list: LeadListRow,
  sequenceStep: SequenceStep,
  sender: SenderIdentity,
  campaignContactId?: string
): Promise<GeneratedEmail> {
  const ctx: LlmContext = {
    purpose: "email",
    campaignId: campaign.id,
    leadListId: list.id,
    contactId: contact.id,
    campaignContactId,
    sequenceStep,
  };
  const brief = await loadBrief(ctx);
  const raw = await completeEmailJson(buildPrompt(contact, campaign, list, sequenceStep, brief), ctx);
  return finalize(raw, sender);
}

const MIN_BODY_LENGTH = 40;
const MAX_BODY_LENGTH = 4000;

export function validateGeneratedEmail(
  subject: string,
  body: string,
  list: LeadListRow
): { pass: true } | { pass: false; reason: string } {
  if (!subject || subject.trim().length === 0) {
    return { pass: false, reason: "Subject is empty" };
  }
  if (!body || body.trim().length < MIN_BODY_LENGTH) {
    return { pass: false, reason: `Body is suspiciously short (under ${MIN_BODY_LENGTH} characters)` };
  }
  if (body.length > MAX_BODY_LENGTH) {
    return { pass: false, reason: `Body is absurdly long (over ${MAX_BODY_LENGTH} characters)` };
  }
  if (list.cta_link && !body.includes(list.cta_link)) {
    return { pass: false, reason: "CTA link is missing from the body" };
  }
  const lowerBody = body.toLowerCase();
  for (const phrase of list.banned_phrases) {
    if (phrase && lowerBody.includes(phrase.toLowerCase())) {
      return { pass: false, reason: `Body contains a banned phrase: "${phrase}"` };
    }
  }

  const expectedSections = countStructureSections(list.raw_email_structure);
  if (expectedSections > 0) {
    const actualSections = countParagraphs(body);
    if (actualSections < expectedSections - 1) {
      return {
        pass: false,
        reason: `Structural deviation: raw structure defines ${expectedSections} section(s), generated body has only ${actualSections} paragraph(s)`,
      };
    }
  }

  return { pass: true };
}

// Testing tab's AI-assisted send: free-text instructions, no campaign or
// lead list involved, so the sender identity has nowhere to default from.
// The caller (the ai-generate route) must resolve one from the request and
// block if it's missing, same rule as the campaign path.
export async function generateTestEmail(
  instructions: string,
  sender: SenderIdentity,
  rawStructure?: string
): Promise<GeneratedEmail> {
  const ctx: LlmContext = { purpose: "test_email" };
  const brief = await loadBrief(ctx);
  const prompt = `Write a single email based on these instructions. Return a subject line and a body.

${
    brief
      ? `${companyContext(null, brief)}\n\n`
      : "COMPANY CONTEXT\nNone has been provided. Do not describe what the company does, its product, features, pricing, or results beyond the exact words used in the instructions below. If the instructions give no such detail, keep the email general rather than guessing.\n\n"
  }INSTRUCTIONS
${instructions}

${rawStructure ? `RAW STRUCTURE TO FOLLOW\n${rawStructure}\n` : ""}
${FACTS_RULE}

${OUTPUT_RULES}`;

  return finalize(await completeEmailJson(prompt, ctx), sender);
}
