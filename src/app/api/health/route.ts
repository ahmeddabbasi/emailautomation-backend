import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { handleRouteError } from "@/lib/api-helpers";

// Everything the code reads or writes on the connected Supabase project.
const TABLES = [
  "campaigns",
  "lead_lists",
  "contacts",
  "campaign_contacts",
  "sends",
  "replies",
  "cron_runs",
  "login_attempts",
  "error_logs",
  "knowledge_items",
  "company_briefs",
  "app_settings",
  "mailboxes",
  "campaign_mailboxes",
  "email_templates",
  "suppressions",
  "import_jobs",
];
const FUNCTIONS = ["error_log_groups", "error_log_facets", "schema_check"];
const BUCKETS = ["campaign-assets", "knowledge-base"];

export async function GET() {
  try {
    const { data, error } = await supabaseAdmin().rpc("schema_check", {
      p_tables: TABLES,
      p_functions: FUNCTIONS,
      p_buckets: BUCKETS,
    });
    if (error) {
      return NextResponse.json(
        { ok: false, error: `Schema check could not run (is the schema_check function missing?): ${error.message}` },
        { status: 503 }
      );
    }
    const missing = data as { tables: string[]; functions: string[]; buckets: string[] };
    const ok = !missing.tables.length && !missing.functions.length && !missing.buckets.length;
    return NextResponse.json({ ok, missing }, { status: ok ? 200 : 503 });
  } catch (err) {
    return handleRouteError(err, "api");
  }
}
