import { NextRequest, NextResponse } from "next/server";
import { processGenerationBatch } from "@/lib/bulk-generation";
import { handleRouteError, jsonError } from "@/lib/api-helpers";

// Processes one small batch of ungenerated initial drafts for this list and
// returns real, persisted progress. The client calls this repeatedly until
// `done` — see the progress UI. Safe to re-call at any time (idempotent:
// only picks up rows still missing a draft), including from a fresh page
// load resuming an interrupted job.
// One draft per request. The browser reaches this through Vercel, which closes
// the connection at 60 seconds. A batch of 10, with provider retries, ran past
// that and the page only saw a 504. The progress UI calls this again until done.
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const result = await processGenerationBatch(id, 1);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof Error && err.message === "Attach this list to a campaign before generating.") {
      return jsonError(400, err.message);
    }
    return handleRouteError(err, "generation");
  }
}
