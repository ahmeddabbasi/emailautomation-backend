import { NextRequest, NextResponse } from "next/server";
import { parseLeadCSV, CsvParseError } from "@/lib/ingestion";
import { CSV_PREVIEW_ROWS, MAX_CSV_BYTES, MAX_CSV_ROWS } from "@/lib/import-limits";
import { jsonError, handleRouteError } from "@/lib/api-helpers";
import { logWarning } from "@/lib/logger";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) return jsonError(400, "Missing file");
    if (file.size > MAX_CSV_BYTES) {
      await logWarning("ingestion", "CSV_TOO_LARGE", "Uploaded CSV exceeds the size limit", {
        details: { filename: file.name, sizeBytes: file.size, limitBytes: MAX_CSV_BYTES },
      });
      return jsonError(400, "This file is larger than 5 MB. Split it into smaller files and upload them one at a time.");
    }

    let parsed;
    try {
      parsed = parseLeadCSV(await file.text());
    } catch (err) {
      if (!(err instanceof CsvParseError)) throw err;
      await logWarning("ingestion", "CSV_PARSE_FAILED", err.message, { details: { filename: file.name, sizeBytes: file.size } });
      return jsonError(400, `${err.message}. Check that the file is a valid CSV export.`);
    }

    if (parsed.headers.length === 0 || parsed.rows.length === 0) {
      await logWarning("ingestion", "CSV_PARSE_FAILED", "Uploaded CSV has no columns or no data rows", {
        details: { filename: file.name, sizeBytes: file.size, headers: parsed.headers },
      });
      return jsonError(400, "Could not find a header row and at least one data row in this file.");
    }
    if (parsed.parseIssues.length > 0) {
      await logWarning("ingestion", "CSV_PARSE_ISSUES", `CSV parsed with ${parsed.parseIssues.length} malformed row(s)`, {
        details: { filename: file.name, issues: parsed.parseIssues },
      });
    }

    if (parsed.rows.length > MAX_CSV_ROWS) {
      return jsonError(400, `This file has ${parsed.rows.length} rows. The limit is ${MAX_CSV_ROWS}.`);
    }

    const { headers, rows, guessedMapping } = parsed;
    return NextResponse.json({
      filename: file.name,
      headers,
      rows,
      previewRows: rows.slice(0, CSV_PREVIEW_ROWS),
      totalRows: rows.length,
      guessedMapping,
    });
  } catch (err) {
    return handleRouteError(err, "ingestion");
  }
}
