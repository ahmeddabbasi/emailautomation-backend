import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { countUnresolvedErrorGroups } from "@/lib/error-logs";
import { handleRouteError } from "@/lib/api-helpers";

export async function GET() {
  try {
    const db = supabaseAdmin();

    const [lastRun, generationFailed, sendFailuresToday, unresolvedErrorGroups] = await Promise.all([
      db.from("cron_runs").select("*").order("started_at", { ascending: false }).limit(1).maybeSingle(),
      db.from("campaign_contacts").select("id", { count: "exact", head: true }).eq("status", "generation_failed"),
      db
        .from("sends")
        .select("id", { count: "exact", head: true })
        .eq("status", "failed")
        .eq("is_test", false)
        .gte("created_at", new Date(Date.now() - 86400000).toISOString()),
      countUnresolvedErrorGroups(),
    ]);

    return NextResponse.json({
      lastRun: lastRun.data ?? null,
      pendingGenerationFailures: generationFailed.count ?? 0,
      sendFailuresLast24h: sendFailuresToday.count ?? 0,
      unresolvedErrorGroups,
    });
  } catch (err) {
    return handleRouteError(err, "analytics");
  }
}
