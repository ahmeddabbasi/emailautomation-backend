import Papa from "papaparse";
import { supabaseAdmin } from "@/lib/supabase/server";
import { ExternalServiceError, errorMessage } from "@/lib/errors";
import { customFieldsForRow, displayName, isValidEmail, normalizeEmail, stripBom, MAX_CSV_ROWS } from "@/lib/import-limits";
import type { ContactSource } from "@/lib/supabase/db-types";

export type MappingKey = "name" | "first_name" | "last_name" | "email" | "company" | "title" | "bio";

const MAPPING_ALIASES: Record<MappingKey, string[]> = {
  name: ["name", "full name", "contact name"],
  first_name: ["first name", "firstname", "first"],
  last_name: ["last name", "lastname", "last", "surname"],
  email: ["email", "e-mail", "email address", "contact email"],
  company: ["company", "company name", "organization", "org"],
  title: ["title", "job title", "position", "role"],
  bio: ["bio", "description", "headline", "notes", "company bio"],
};

const FIRST_NAME_HEADERS = ["first name", "firstname", "first"];
const LAST_NAME_HEADERS = ["last name", "lastname", "last", "surname"];

// Apollo exports split the name into "First Name" / "Last Name"; the mapping
// only has one name slot, so a mapped first-name column picks up its
// last-name sibling instead of silently dropping the surname.
function fullName(row: Record<string, string>, nameHeader: string | null): string {
  if (!nameHeader) return "";
  const first = row[nameHeader]?.trim() ?? "";
  if (!FIRST_NAME_HEADERS.includes(nameHeader.trim().toLowerCase())) return first;
  const lastHeader = Object.keys(row).find((h) => LAST_NAME_HEADERS.includes(h.trim().toLowerCase()));
  const last = lastHeader ? row[lastHeader]?.trim() ?? "" : "";
  return [first, last].filter(Boolean).join(" ");
}

export interface ParsedLeadCsv {
  headers: string[];
  rows: Record<string, string>[];
  guessedMapping: Record<MappingKey, string | null>;
  parseIssues: { row: number | undefined; message: string }[];
}

export class CsvParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvParseError";
  }
}

export function guessMapping(headers: string[]): Record<MappingKey, string | null> {
  const mapping: Record<MappingKey, string | null> = {
    name: null,
    first_name: null,
    last_name: null,
    email: null,
    company: null,
    title: null,
    bio: null,
  };
  for (const key of Object.keys(mapping) as MappingKey[]) {
    const aliases = MAPPING_ALIASES[key];
    const match = headers.find((h) => aliases.includes(h.trim().toLowerCase()));
    if (match) mapping[key] = match;
  }
  return mapping;
}

export function parseLeadCSV(fileText: string): ParsedLeadCsv {
  const result = Papa.parse<Record<string, string>>(stripBom(fileText), {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim(),
  });

  if (result.errors.length > 0 && result.data.length === 0) {
    throw new CsvParseError(`Could not parse CSV: ${result.errors[0].message}`);
  }

  const headers = result.meta.fields ?? [];
  const parseIssues = result.errors.slice(0, 20).map((e) => ({ row: e.row, message: e.message }));
  return { headers, rows: result.data, guessedMapping: guessMapping(headers), parseIssues };
}

interface RejectedRow {
  row: Record<string, string>;
  reason: string;
}

export interface CommitResult {
  inserted: number;
  duplicates: number;
  rejected: RejectedRow[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

async function enrolledContactIds(leadListId: string, contactIds: string[]): Promise<Set<string>> {
  const db = supabaseAdmin();
  const enrolled = new Set<string>();
  for (const batch of chunk(contactIds, 200)) {
    const { data, error } = await db
      .from("campaign_contacts")
      .select("contact_id")
      .eq("lead_list_id", leadListId)
      .in("contact_id", batch);
    if (error) throw new ExternalServiceError("supabase", `Failed to check existing enrollments: ${errorMessage(error)}`, error);
    for (const row of data ?? []) enrolled.add(row.contact_id);
  }
  return enrolled;
}

// dryRun runs every validation and lookup the real commit does and returns
// the same counts, but writes nothing — it's what the import preview shows
// before the operator confirms.
export async function commitContacts(
  rows: Record<string, string>[],
  mapping: Record<MappingKey, string | null>,
  leadListId: string,
  source: ContactSource,
  { dryRun = false }: { dryRun?: boolean } = {}
): Promise<CommitResult> {
  const db = supabaseAdmin();

  interface Extracted {
    name: string;
    firstName: string;
    lastName: string;
    email: string;
    company: string;
    title: string;
    bio: string;
    customFields: Record<string, string>;
    row: Record<string, string>;
  }

  if (rows.length > MAX_CSV_ROWS) {
    throw new ExternalServiceError("supabase", `CSV has ${rows.length} rows. The limit is ${MAX_CSV_ROWS}.`);
  }

  const valid: Extracted[] = [];
  const rejected: RejectedRow[] = [];
  const seenEmails = new Set<string>();

  for (const row of rows) {
    const firstName = (mapping.first_name ? row[mapping.first_name] : "")?.trim() ?? "";
    const lastName = (mapping.last_name ? row[mapping.last_name] : "")?.trim() ?? "";
    const email = normalizeEmail(mapping.email ? row[mapping.email] ?? "" : "");
    const company = (mapping.company ? row[mapping.company] : "")?.trim() ?? "";
    const title = (mapping.title ? row[mapping.title] : "")?.trim() ?? "";
    const bio = (mapping.bio ? row[mapping.bio] : "")?.trim() ?? "";
    const name = displayName({ name: fullName(row, mapping.name), firstName, lastName, email });

    if (!email) {
      rejected.push({ row, reason: "Missing email" });
      continue;
    }
    if (!isValidEmail(email)) {
      rejected.push({ row, reason: "Invalid email format" });
      continue;
    }
    if (seenEmails.has(email)) {
      rejected.push({ row, reason: "Duplicate email within this file" });
      continue;
    }
    seenEmails.add(email);
    valid.push({
      name,
      firstName,
      lastName,
      email,
      company,
      title,
      bio,
      customFields: customFieldsForRow(row, Object.values(mapping)),
      row,
    });
  }

  if (valid.length === 0) {
    return { inserted: 0, duplicates: 0, rejected };
  }

  const emails = valid.map((v) => v.email);
  const existingContacts = new Map<string, string>();

  for (const batch of chunk(emails, 200)) {
    const { data, error } = await db.from("contacts").select("id, email").in("email", batch);
    if (error) throw new ExternalServiceError("supabase", `Failed to look up existing contacts: ${errorMessage(error)}`, error);
    for (const row of data ?? []) existingContacts.set(row.email, row.id);
  }

  const suppressed = new Set<string>();
  for (const batch of chunk(emails, 200)) {
    const { data, error } = await db.from("suppressions").select("email").in("email", batch);
    if (error) throw new ExternalServiceError("supabase", `Failed to check the suppression list: ${errorMessage(error)}`, error);
    for (const row of data ?? []) suppressed.add(row.email);
  }
  const stillValid: Extracted[] = [];
  for (const entry of valid) {
    if (suppressed.has(entry.email)) rejected.push({ row: entry.row, reason: "Unsubscribed" });
    else stillValid.push(entry);
  }
  valid.length = 0;
  valid.push(...stillValid);

  if (valid.length === 0) {
    return { inserted: 0, duplicates: 0, rejected };
  }

  if (dryRun) {
    const enrolled = await enrolledContactIds(leadListId, [...existingContacts.values()]);
    const duplicates = valid.filter((v) => enrolled.has(existingContacts.get(v.email) ?? "")).length;
    return { inserted: valid.length - duplicates, duplicates, rejected };
  }

  const toInsert = valid.filter((v) => !existingContacts.has(v.email));
  if (toInsert.length > 0) {
    for (const batch of chunk(toInsert, 200)) {
      const { data, error } = await db
        .from("contacts")
        .insert(
          batch.map((v) => ({
            name: v.name,
            first_name: v.firstName,
            last_name: v.lastName,
            email: v.email,
            company: v.company,
            title: v.title,
            company_bio: v.bio,
            custom_fields: v.customFields,
            source,
          }))
        )
        .select("id, email");
      if (error) throw new ExternalServiceError("supabase", `Failed to insert contacts: ${errorMessage(error)}`, error);
      for (const row of data ?? []) existingContacts.set(row.email, row.id);
    }
  }

  const alreadyEnrolled = await enrolledContactIds(
    leadListId,
    valid.map((v) => existingContacts.get(v.email)!)
  );

  const enrollments = valid
    .map((v) => ({ contactId: existingContacts.get(v.email)!, source: v }))
    .filter((e) => !alreadyEnrolled.has(e.contactId));

  const now = new Date().toISOString();
  let inserted = 0;

  // status='queued': not yet eligible for the scheduler — the bulk
  // generation job flips a row to 'pending' once its initial draft exists.
  for (const batch of chunk(enrollments, 200)) {
    const { error } = await db.from("campaign_contacts").insert(
      batch.map((e) => ({
        lead_list_id: leadListId,
        contact_id: e.contactId,
        status: "queued" as const,
        sequence_step: 0 as const,
        next_send_at: now,
      }))
    );
    if (error) throw new ExternalServiceError("supabase", `Failed to enroll contacts: ${errorMessage(error)}`, error);
    inserted += batch.length;
  }

  const duplicates = valid.length - enrollments.length;

  if (inserted > 0) {
    const { data: list, error: listErr } = await db
      .from("lead_lists")
      .select("generation_total")
      .eq("id", leadListId)
      .single();
    if (!listErr && list) {
      await db
        .from("lead_lists")
        .update({ generation_total: list.generation_total + inserted, generation_status: "pending" })
        .eq("id", leadListId);
    }
  }

  return { inserted, duplicates, rejected };
}
