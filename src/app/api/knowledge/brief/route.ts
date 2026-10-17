import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { regenerateBrief, saveEditedBrief } from "@/lib/knowledge";
import { jsonError, handleRouteError } from "@/lib/api-helpers";

export const maxDuration = 60;

// Manual "Regenerate" button.
export async function POST() {
  try {
    const outcome = await regenerateBrief();
    if ("brief" in outcome) return NextResponse.json({ brief: outcome.brief });
    if (outcome.skipped === "empty") {
      return jsonError(400, "Add or enable at least one document, link, or company fact first.");
    }
    return jsonError(409, "The knowledge base changed while the brief was being written. Press Regenerate again.");
  } catch (err) {
    return handleRouteError(err, "knowledge");
  }
}

const schema = z.object({ content: z.string().trim().min(1, "The brief can't be empty").max(20000) });

// Manual edit: saved as a new version so the previous one stays on record.
export async function PUT(request: NextRequest) {
  try {
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return jsonError(400, parsed.error.issues[0]?.message ?? "Invalid brief");
    const brief = await saveEditedBrief(parsed.data.content);
    return NextResponse.json({ brief });
  } catch (err) {
    return handleRouteError(err, "knowledge");
  }
}
