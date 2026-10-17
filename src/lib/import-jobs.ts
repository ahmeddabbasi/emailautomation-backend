import { supabaseAdmin } from "@/lib/supabase/server";
import { ExternalServiceError, errorMessage } from "@/lib/errors";
import { commitContacts, type MappingKey } from "@/lib/ingestion";
import { CSV_IMPORT_BATCH } from "@/lib/import-limits";
import type { ContactSource } from "@/lib/supabase/db-types";

export async function createImportJob(
  leadListId: string,
  source: ContactSource,
  mapping: Record<MappingKey, string | null>,
  rows: Record<string, string>[]
): Promise<string> {
  const db = supabaseAdmin();
  const { data, error } = await db
    .from("import_jobs")
    .insert({
      lead_list_id: leadListId,
      source,
      status: "pending",
      total_rows: rows.length,
      rows,
      mapping,
    })
    .select("id")
    .single();
  if (error || !data) throw new ExternalServiceError("supabase", `Failed to start the import: ${errorMessage(error)}`, error);
  return data.id;
}

export async function advanceImportJob(jobId: string) {
  const db = supabaseAdmin();
  const { data: job, error } = await db.from("import_jobs").select("*").eq("id", jobId).maybeSingle();
  if (error || !job) throw new ExternalServiceError("supabase", `Import job not found: ${errorMessage(error)}`, error);
  if (job.status === "completed" || job.status === "failed") {
    return {
      done: true,
      imported: job.imported,
      duplicates: job.duplicates,
      invalidCount: job.invalid_count,
      invalidRows: job.invalid_rows ?? [],
      total: job.total_rows,
    };
  }

  const rows = (job.rows ?? []) as Record<string, string>[];
  const batch = rows.slice(0, CSV_IMPORT_BATCH);
  const rest = rows.slice(CSV_IMPORT_BATCH);
  const mapping = job.mapping as Record<MappingKey, string | null>;

  try {
    const result = await commitContacts(batch, mapping, job.lead_list_id, job.source);
    const invalidRows = [...((job.invalid_rows ?? []) as { row: Record<string, string>; reason: string }[]), ...result.rejected].slice(0, 500);
    const done = rest.length === 0;
    const imported = job.imported + result.inserted;
    const duplicates = job.duplicates + result.duplicates;
    const invalidCount = job.invalid_count + result.rejected.length;
    const { error: updateError } = await db
      .from("import_jobs")
      .update({
        status: done ? "completed" : "running",
        imported,
        duplicates,
        invalid_count: invalidCount,
        invalid_rows: invalidRows,
        rows: rest,
      })
      .eq("id", jobId);
    if (updateError) throw new ExternalServiceError("supabase", `Failed to update the import: ${errorMessage(updateError)}`, updateError);
    return { done, imported, duplicates, invalidCount, invalidRows, total: job.total_rows };
  } catch (err) {
    await db.from("import_jobs").update({ status: "failed", error_message: errorMessage(err) }).eq("id", jobId);
    throw err;
  }
}

export async function advancePendingImports(maxJobs = 1): Promise<void> {
  const db = supabaseAdmin();
  const { data } = await db.from("import_jobs").select("id").in("status", ["pending", "running"]).order("created_at", { ascending: true }).limit(maxJobs);
  for (const job of data ?? []) {
    await advanceImportJob(job.id);
  }
}
