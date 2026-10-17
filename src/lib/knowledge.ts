import "server-only";
import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";
import { ExternalServiceError, errorMessage } from "@/lib/errors";
import { completeText } from "@/lib/llm";
import { logError, logWarning } from "@/lib/logger";
import { extractDocumentText, extractUrlText, ExtractionError, type SupportedKind } from "@/lib/extraction";

export const KNOWLEDGE_BUCKET = "knowledge-base";

export const DOC_TYPES = ["company_profile", "product", "pricing", "terms", "privacy", "case_studies", "other"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  company_profile: "Company database / profile",
  product: "Product information",
  pricing: "Pricing",
  terms: "Terms of Use",
  privacy: "Privacy Policy",
  case_studies: "Case studies",
  other: "Other",
};

const COMPLIANCE_TYPES: DocType[] = ["terms", "privacy"];

export interface ActiveBrief {
  id: string;
  version: number;
  content: string;
}

interface KnowledgeRow {
  id: string;
  created_at: string;
  updated_at: string;
  kind: "document" | "link" | "facts";
  doc_type: DocType;
  title: string;
  enabled: boolean;
  file_path: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  url: string | null;
  last_fetched_at: string | null;
  extracted_text: string;
  extraction_status: "ok" | "empty" | "failed";
  extraction_error: string | null;
}

export interface KnowledgeItem {
  id: string;
  kind: "document" | "link";
  docType: DocType;
  title: string;
  enabled: boolean;
  fileName: string | null;
  sizeBytes: number | null;
  url: string | null;
  lastFetchedAt: string | null;
  textLength: number;
  preview: string;
  status: "ok" | "empty" | "failed";
  error: string | null;
  updatedAt: string;
}

export interface BriefInfo {
  id: string;
  version: number;
  content: string;
  origin: "generated" | "edited";
  provider: string | null;
  createdAt: string;
}

const BRIEF_CACHE_MS = 60_000;
const PREVIEW_CHARS = 1200;
const MAX_SOURCE_CHARS_PER_ITEM = 15_000;
const MAX_SOURCE_CHARS_TOTAL = 60_000;
let cached: { brief: ActiveBrief | null; at: number } | null = null;

function dbFail(what: string, error: unknown): never {
  throw new ExternalServiceError("supabase", `${what}: ${errorMessage(error)}`, error);
}

function toItem(row: KnowledgeRow): KnowledgeItem {
  return {
    id: row.id,
    kind: row.kind as "document" | "link",
    docType: row.doc_type,
    title: row.title,
    enabled: row.enabled,
    fileName: row.file_name,
    sizeBytes: row.size_bytes,
    url: row.url,
    lastFetchedAt: row.last_fetched_at,
    textLength: row.extracted_text.length,
    preview: row.extracted_text.slice(0, PREVIEW_CHARS),
    status: row.extraction_status,
    error: row.extraction_error,
    updatedAt: row.updated_at,
  };
}

async function allRows(): Promise<KnowledgeRow[]> {
  const { data, error } = await supabaseAdmin().from("knowledge_items").select("*").order("created_at", { ascending: true });
  if (error) dbFail("Failed to load the knowledge base", error);
  return (data ?? []) as KnowledgeRow[];
}

// Identifies the exact enabled content a brief was built from, so the UI
// can tell when the knowledge base has changed since.
function sourceHash(rows: KnowledgeRow[]): string {
  const enabled = rows
    .filter((r) => r.enabled && r.extracted_text.trim())
    .map((r) => `${r.id}:${r.doc_type}:${createHash("md5").update(r.extracted_text).digest("hex")}`)
    .sort();
  return createHash("md5").update(enabled.join("|")).digest("hex");
}

export function invalidateBriefCache() {
  cached = null;
}

// Read on every generation, so it's memoised briefly: a batch of 50 drafts
// shouldn't mean 50 identical queries.
export async function getActiveBrief(): Promise<ActiveBrief | null> {
  if (cached && Date.now() - cached.at < BRIEF_CACHE_MS) return cached.brief;
  const { data, error } = await supabaseAdmin()
    .from("company_briefs")
    .select("id, version, content")
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(`Failed to load the company brief: ${errorMessage(error)}`);
  const brief = data && data.content.trim() ? (data as ActiveBrief) : null;
  cached = { brief, at: Date.now() };
  return brief;
}

export interface KnowledgeOverview {
  documents: KnowledgeItem[];
  links: KnowledgeItem[];
  facts: string;
  brief: BriefInfo | null;
  briefStale: boolean;
  enabledSources: number;
}

export async function getKnowledgeOverview(): Promise<KnowledgeOverview> {
  const rows = await allRows();
  const { data: brief, error } = await supabaseAdmin()
    .from("company_briefs")
    .select("id, version, content, origin, provider, created_at, source_hash")
    .eq("is_active", true)
    .maybeSingle();
  if (error) dbFail("Failed to load the company brief", error);
  const enabledSources = rows.filter((r) => r.enabled && r.extracted_text.trim()).length;

  return {
    documents: rows.filter((r) => r.kind === "document").map(toItem),
    links: rows.filter((r) => r.kind === "link").map(toItem),
    facts: rows.find((r) => r.kind === "facts")?.extracted_text ?? "",
    brief: brief
      ? { id: brief.id, version: brief.version, content: brief.content, origin: brief.origin, provider: brief.provider, createdAt: brief.created_at }
      : null,
    briefStale: brief ? brief.source_hash !== sourceHash(rows) : enabledSources > 0,
    enabledSources,
  };
}

export async function saveFacts(text: string): Promise<void> {
  const db = supabaseAdmin();
  const now = new Date().toISOString();
  const trimmed = text.trim();
  const { data: existing } = await db.from("knowledge_items").select("id").eq("kind", "facts").maybeSingle();
  const row = { extracted_text: trimmed, extraction_status: trimmed ? "ok" : "empty", updated_at: now };
  const { error } = existing
    ? await db.from("knowledge_items").update(row).eq("id", existing.id)
    : await db.from("knowledge_items").insert({ ...row, kind: "facts", title: "Company facts", doc_type: "company_profile" });
  if (error) dbFail("Failed to save company facts", error);
}

export async function addDocument(file: { name: string; type: string; data: Buffer }, kind: SupportedKind, docType: DocType, title: string) {
  const db = supabaseAdmin();
  const path = `${Date.now()}-${file.name.replace(/[^\w.-]+/g, "_")}`;
  const { error: uploadError } = await db.storage.from(KNOWLEDGE_BUCKET).upload(path, file.data, { contentType: file.type || "application/octet-stream" });
  if (uploadError) dbFail("Failed to store the uploaded file", uploadError);

  let text = "";
  let status: "ok" | "empty" | "failed" = "failed";
  let extractionError: string | null = null;
  try {
    const extracted = await extractDocumentText(file.data, kind);
    text = extracted.text;
    status = extracted.status;
    extractionError = extracted.warning;
  } catch (err) {
    extractionError = err instanceof ExtractionError ? err.message : `Text extraction failed: ${errorMessage(err)}`;
  }

  if (status !== "ok") {
    await (status === "failed" ? logError : logWarning)("knowledge", status === "failed" ? "DOCUMENT_EXTRACTION_FAILED" : "DOCUMENT_NO_TEXT", extractionError ?? "No text extracted", {
      details: { fileName: file.name, mimeType: file.type, sizeBytes: file.data.length, docType },
    });
  }

  const { data, error } = await db
    .from("knowledge_items")
    .insert({
      kind: "document",
      doc_type: docType,
      title,
      file_path: path,
      file_name: file.name,
      mime_type: file.type,
      size_bytes: file.data.length,
      extracted_text: text,
      extraction_status: status,
      extraction_error: extractionError,
    })
    .select("*")
    .single();
  if (error) dbFail("Failed to save the document", error);
  return toItem(data as KnowledgeRow);
}

async function fetchLink(url: string) {
  try {
    const extracted = await extractUrlText(url);
    return { text: extracted.text, status: extracted.status, error: extracted.warning };
  } catch (err) {
    const message = err instanceof ExtractionError ? err.message : `Fetching the page failed: ${errorMessage(err)}`;
    return { text: "", status: "failed" as const, error: message };
  }
}

async function logLinkProblem(url: string, result: { status: string; error: string | null }) {
  if (result.status === "ok") return;
  await (result.status === "failed" ? logError : logWarning)("knowledge", result.status === "failed" ? "LINK_FETCH_FAILED" : "LINK_NO_TEXT", result.error ?? "No text extracted", {
    details: { url },
  });
}

export async function addLink(url: string, title: string, docType: DocType) {
  const result = await fetchLink(url);
  await logLinkProblem(url, result);
  const { data, error } = await supabaseAdmin()
    .from("knowledge_items")
    .insert({
      kind: "link",
      doc_type: docType,
      title,
      url,
      last_fetched_at: new Date().toISOString(),
      extracted_text: result.text,
      extraction_status: result.status,
      extraction_error: result.error,
    })
    .select("*")
    .single();
  if (error) dbFail("Failed to save the link", error);
  return toItem(data as KnowledgeRow);
}

export async function refreshLink(id: string) {
  const db = supabaseAdmin();
  const { data: row, error: loadError } = await db.from("knowledge_items").select("url").eq("id", id).eq("kind", "link").maybeSingle();
  if (loadError) dbFail("Failed to load the link", loadError);
  if (!row?.url) return null;
  const result = await fetchLink(row.url);
  await logLinkProblem(row.url, result);
  // A failed refresh keeps the previously extracted text rather than wiping
  // content that was working; only the status and error change.
  const update =
    result.status === "failed"
      ? { extraction_status: "failed", extraction_error: result.error, last_fetched_at: new Date().toISOString() }
      : { extracted_text: result.text, extraction_status: result.status, extraction_error: result.error, last_fetched_at: new Date().toISOString() };
  const { data, error } = await db
    .from("knowledge_items")
    .update({ ...update, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("*")
    .single();
  if (error) dbFail("Failed to save the refreshed link", error);
  return toItem(data as KnowledgeRow);
}

export async function updateItem(id: string, patch: { title?: string; enabled?: boolean; docType?: DocType }) {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.enabled !== undefined) row.enabled = patch.enabled;
  if (patch.docType !== undefined) row.doc_type = patch.docType;
  const { data, error } = await supabaseAdmin().from("knowledge_items").update(row).eq("id", id).neq("kind", "facts").select("*").maybeSingle();
  if (error) dbFail("Failed to update the item", error);
  return data ? toItem(data as KnowledgeRow) : null;
}

export async function deleteItem(id: string): Promise<boolean> {
  const db = supabaseAdmin();
  const { data, error } = await db.from("knowledge_items").delete().eq("id", id).neq("kind", "facts").select("file_path").maybeSingle();
  if (error) dbFail("Failed to delete the item", error);
  if (!data) return false;
  if (data.file_path) {
    const { error: removeError } = await db.storage.from(KNOWLEDGE_BUCKET).remove([data.file_path]);
    if (removeError) {
      await logWarning("knowledge", "STORAGE_DELETE_FAILED", "Deleted a document but its stored file could not be removed", {
        details: { filePath: data.file_path, error: removeError.message },
      });
    }
  }
  return true;
}

function sourcesForPrompt(rows: KnowledgeRow[]): string {
  let budget = MAX_SOURCE_CHARS_TOTAL;
  const parts: string[] = [];
  const ordered = [...rows].sort((a, b) => Number(COMPLIANCE_TYPES.includes(a.doc_type)) - Number(COMPLIANCE_TYPES.includes(b.doc_type)));
  for (const r of ordered) {
    if (budget <= 0) break;
    const text = r.extracted_text.slice(0, Math.min(MAX_SOURCE_CHARS_PER_ITEM, budget));
    budget -= text.length;
    const label = r.kind === "facts" ? "Company facts typed by the operator" : `${DOC_TYPE_LABELS[r.doc_type]}: ${r.title}`;
    parts.push(`=== SOURCE: ${label} ===\n${text}`);
  }
  return parts.join("\n\n");
}

const BRIEF_PROMPT = `You are preparing a company brief that an AI will use as its only source of facts when writing cold outreach emails for this company.

Write the brief from the sources below. Rules:
- Use only facts stated in the sources. Never infer, estimate, or invent features, prices, numbers, customers, or results.
- Copy figures and product names exactly as written. Leave out all prices, plan prices, and discount terms: a discount may appear in an email only through the lead list early-bird line, never from the brief.
- Keep the company own cautions: do not mention testimonials or customer results if none exist, mention only languages the sources say are finished, and describe publishing only as the user pressing publish.
- Be concise: at most about 450 words. Plain text with short headed sections and simple "- " bullets. No markdown bold or headings syntax, no em dashes.
- Sections, omitting any with no supporting facts: What the company does; Products and features; Who it is for; Cautions; Proof points only if real ones exist.
- If Terms of Use or Privacy Policy sources are present, end with a section "Compliance notes" listing, in a few bullets, what outreach must not promise or claim because of them (for example guarantees, data handling claims). Nothing that appears only in the Terms of Use or Privacy Policy may appear in any other section; they are for accuracy only and must never be quoted in emails.

SOURCES
`;

async function nextVersion(): Promise<number> {
  const { data, error } = await supabaseAdmin().from("company_briefs").select("version").order("version", { ascending: false }).limit(1).maybeSingle();
  if (error) dbFail("Failed to read brief versions", error);
  return (data?.version ?? 0) + 1;
}

async function activateNewBrief(fields: { content: string; source_hash: string; origin: "generated" | "edited"; provider: string | null }): Promise<BriefInfo> {
  const db = supabaseAdmin();
  for (let attempt = 0; attempt < 3; attempt++) {
    const version = await nextVersion();
    const { data, error } = await db.from("company_briefs").insert({ ...fields, version, is_active: false }).select("*").single();
    if (error?.code === "23505") continue;
    if (error || !data) dbFail("Failed to save the company brief", error);
    const { error: clearError } = await db.from("company_briefs").update({ is_active: false }).eq("is_active", true);
    if (clearError) dbFail("Failed to switch the active brief", clearError);
    const { error: setError } = await db.from("company_briefs").update({ is_active: true }).eq("id", data.id);
    if (setError) dbFail("Failed to activate the new brief", setError);
    invalidateBriefCache();
    return { id: data.id, version: data.version, content: data.content, origin: data.origin, provider: data.provider, createdAt: data.created_at };
  }
  throw new ExternalServiceError("supabase", "Could not allocate a brief version number");
}

async function retireActiveBrief() {
  const { error } = await supabaseAdmin().from("company_briefs").update({ is_active: false }).eq("is_active", true);
  if (error) dbFail("Failed to retire the company brief", error);
  invalidateBriefCache();
}

export type RegenerateOutcome = { brief: BriefInfo } | { skipped: "empty" | "changed" };

export async function regenerateBrief(): Promise<RegenerateOutcome> {
  const snapshot = await allRows();
  const rows = snapshot.filter((r) => r.enabled && r.extracted_text.trim());
  if (rows.length === 0) {
    // Nothing enabled any more: stop feeding the old brief into emails.
    await retireActiveBrief();
    return { skipped: "empty" };
  }
  const hash = sourceHash(snapshot);
  const { text, provider } = await completeText(BRIEF_PROMPT + sourcesForPrompt(rows), { purpose: "company_brief" });
  const content = text.replace(/\*\*/g, "").replace(/^#+\s*/gm, "").trim();
  if (!content) throw new ExternalServiceError(provider, "The model returned an empty brief");

  // Changes made while the model was writing each trigger their own
  // regeneration; activating this one now would let an older snapshot win.
  if (sourceHash(await allRows()) !== hash) return { skipped: "changed" };
  return { brief: await activateNewBrief({ content, source_hash: hash, origin: "generated", provider }) };
}

export async function saveEditedBrief(content: string): Promise<BriefInfo> {
  return activateNewBrief({ content: content.trim(), source_hash: sourceHash(await allRows()), origin: "edited", provider: null });
}

// Fired after any knowledge-base change. Failures are logged, not thrown:
// the change itself already succeeded and the UI shows the brief as stale.
export async function regenerateBriefQuietly(reason: string): Promise<void> {
  try {
    const { data: active } = await supabaseAdmin().from("company_briefs").select("source_hash").eq("is_active", true).maybeSingle();
    const rows = await allRows();
    const hasContent = rows.some((r) => r.enabled && r.extracted_text.trim());
    if (hasContent && active?.source_hash === sourceHash(rows)) return;
    if (!hasContent && !active) return;
    await regenerateBrief();
  } catch (err) {
    await logError("knowledge", "BRIEF_REGENERATION_FAILED", `Company brief could not be regenerated after ${reason}: ${errorMessage(err)}`, {
      error: err,
    });
  }
}
