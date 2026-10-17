import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { handleRouteError } from "@/lib/api-helpers";
import { errorMessage } from "@/lib/errors";

// Resets initial-generation failures back to 'queued' so the next
// /generate batch call picks them up again. Only touches step-0 rows —
// a follow-up generation failure is retried differently (it re-attempts
// live at the next eligible dispatch tick once the operator flips it back
// to pending via the contact status endpoint).
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const db = supabaseAdmin();
    const { data, error } = await db
      .from("campaign_contacts")
      .update({ status: "queued" })
      .eq("lead_list_id", id)
      .eq("status", "generation_failed")
      .eq("sequence_step", 0)
      .select("id");
    if (error) throw new Error(`Failed to reset failed contacts: ${errorMessage(error)}`);
    const resetCount = data?.length ?? 0;

    const { data: list } = await db.from("lead_lists").select("generation_failed_count").eq("id", id).single();
    await db
      .from("lead_lists")
      .update({
        generation_status: "running",
        generation_failed_count: Math.max(0, (list?.generation_failed_count ?? resetCount) - resetCount),
      })
      .eq("id", id);

    return NextResponse.json({ reset: resetCount });
  } catch (err) {
    return handleRouteError(err, "generation");
  }
}
