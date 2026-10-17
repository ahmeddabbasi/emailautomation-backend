import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { commitContacts } from "@/lib/ingestion";
import { createImportJob } from "@/lib/import-jobs";
import { CSV_SYNC_ROW_LIMIT } from "@/lib/import-limits";
import { jsonError, handleRouteError } from "@/lib/api-helpers";
import { logWarning } from "@/lib/logger";

const mappingSchema = z.object({
  name: z.string().nullable(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  email: z.string().nullable(),
  company: z.string().nullable(),
  title: z.string().nullable(),
  bio: z.string().nullable(),
});

const commitSchema = z.object({
  leadListId: z.string().uuid(),
  source: z.enum(["apollo", "manual"]),
  mapping: mappingSchema,
  rows: z.array(z.record(z.string(), z.string())),
  dryRun: z.boolean().default(false),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = commitSchema.safeParse(body);
    if (!parsed.success) {
      return jsonError(400, "Invalid commit payload", { issues: parsed.error.issues });
    }
    if (!parsed.data.mapping.email) {
      return jsonError(400, "The email column must be mapped");
    }

    const mapping = {
      name: parsed.data.mapping.name,
      first_name: parsed.data.mapping.first_name ?? null,
      last_name: parsed.data.mapping.last_name ?? null,
      email: parsed.data.mapping.email,
      company: parsed.data.mapping.company,
      title: parsed.data.mapping.title,
      bio: parsed.data.mapping.bio,
    };

    if (!parsed.data.dryRun && parsed.data.rows.length > CSV_SYNC_ROW_LIMIT) {
      const jobId = await createImportJob(parsed.data.leadListId, parsed.data.source, mapping, parsed.data.rows);
      return NextResponse.json({ async: true, jobId, done: false, total: parsed.data.rows.length });
    }

    const result = await commitContacts(
      parsed.data.rows,
      mapping,
      parsed.data.leadListId,
      parsed.data.source,
      { dryRun: parsed.data.dryRun }
    );
    if (!parsed.data.dryRun && result.rejected.length > 0) {
      await logWarning("ingestion", "CSV_ROWS_REJECTED", `${result.rejected.length} row(s) rejected during import`, {
        details: {
          leadListId: parsed.data.leadListId,
          inserted: result.inserted,
          duplicates: result.duplicates,
          rejected: result.rejected.slice(0, 20).map((r) => r.reason),
        },
      });
    }
    return NextResponse.json(result);
  } catch (err) {
    return handleRouteError(err, "ingestion");
  }
}
