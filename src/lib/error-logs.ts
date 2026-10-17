import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";
import { errorMessage } from "@/lib/errors";

export interface ErrorLogFilters {
  level?: "error" | "warning";
  source?: string;
  code?: string;
  resolved?: boolean;
  from?: string;
  to?: string;
  q?: string;
}

export interface ErrorLogGroup {
  fingerprint: string;
  level: "error" | "warning";
  source: string;
  code: string;
  message: string;
  occurrences: number;
  unresolved: number;
  firstSeen: string;
  lastSeen: string;
}

export interface ErrorLogOccurrence {
  id: string;
  createdAt: string;
  level: "error" | "warning";
  source: string;
  code: string;
  message: string;
  details: Record<string, unknown>;
  stack: string | null;
  resolved: boolean;
  resolvedAt: string | null;
}

const PAGE_SIZE = 50;

interface GroupRow {
  fingerprint: string;
  level: "error" | "warning";
  source: string;
  code: string;
  message: string;
  occurrences: number;
  unresolved: number;
  first_seen: string;
  last_seen: string;
  total_groups: number;
}

export async function listErrorLogGroups(filters: ErrorLogFilters, page = 1): Promise<{ groups: ErrorLogGroup[]; total: number }> {
  const { data, error } = await supabaseAdmin().rpc("error_log_groups", {
    p_level: filters.level ?? null,
    p_source: filters.source ?? null,
    p_code: filters.code ?? null,
    p_resolved: filters.resolved ?? null,
    p_from: filters.from ?? null,
    p_to: filters.to ?? null,
    p_search: filters.q?.trim() || null,
    p_limit: PAGE_SIZE,
    p_offset: (page - 1) * PAGE_SIZE,
  });
  if (error) throw new Error(`Failed to load error logs: ${errorMessage(error)}`);

  const rows = (data ?? []) as GroupRow[];
  return {
    total: Number(rows[0]?.total_groups ?? 0),
    groups: rows.map((r) => ({
      fingerprint: r.fingerprint,
      level: r.level,
      source: r.source,
      code: r.code,
      message: r.message,
      occurrences: Number(r.occurrences),
      unresolved: Number(r.unresolved),
      firstSeen: r.first_seen,
      lastSeen: r.last_seen,
    })),
  };
}

export async function listOccurrences(fingerprint: string, filters: ErrorLogFilters): Promise<ErrorLogOccurrence[]> {
  let query = supabaseAdmin()
    .from("error_logs")
    .select("id, created_at, level, source, code, message, details, stack, resolved, resolved_at")
    .eq("fingerprint", fingerprint)
    .order("created_at", { ascending: false })
    .limit(200);
  if (filters.resolved !== undefined) query = query.eq("resolved", filters.resolved);
  if (filters.from) query = query.gte("created_at", filters.from);
  if (filters.to) query = query.lt("created_at", filters.to);

  const { data, error } = await query;
  if (error) throw new Error(`Failed to load log occurrences: ${errorMessage(error)}`);
  return (data ?? []).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    level: r.level,
    source: r.source,
    code: r.code,
    message: r.message,
    details: r.details ?? {},
    stack: r.stack,
    resolved: r.resolved,
    resolvedAt: r.resolved_at,
  }));
}

export async function listFacets(): Promise<{ codes: string[]; sources: string[] }> {
  const { data, error } = await supabaseAdmin().rpc("error_log_facets");
  if (error) throw new Error(`Failed to load log filters: ${errorMessage(error)}`);
  const rows = (data ?? []) as { code: string; source: string }[];
  return {
    codes: [...new Set(rows.map((r) => r.code))].sort(),
    sources: [...new Set(rows.map((r) => r.source))].sort(),
  };
}

export async function setResolved(target: { ids?: string[]; fingerprints?: string[] }, resolved: boolean): Promise<number> {
  const db = supabaseAdmin();
  const update = { resolved, resolved_at: resolved ? new Date().toISOString() : null };
  let count = 0;
  if (target.ids?.length) {
    const { data, error } = await db.from("error_logs").update(update).in("id", target.ids).neq("resolved", resolved).select("id");
    if (error) throw new Error(`Failed to update log entries: ${errorMessage(error)}`);
    count += data?.length ?? 0;
  }
  if (target.fingerprints?.length) {
    const { data, error } = await db
      .from("error_logs")
      .update(update)
      .in("fingerprint", target.fingerprints)
      .neq("resolved", resolved)
      .select("id");
    if (error) throw new Error(`Failed to update log groups: ${errorMessage(error)}`);
    count += data?.length ?? 0;
  }
  return count;
}

// Distinct unresolved error-level problems, for the sidebar badge: a flood
// of one failure counts once.
export async function countUnresolvedErrorGroups(): Promise<number> {
  const { data, error } = await supabaseAdmin().rpc("error_log_groups", {
    p_level: "error",
    p_resolved: false,
    p_limit: 1,
    p_offset: 0,
  });
  if (error) throw new Error(`Failed to count unresolved errors: ${errorMessage(error)}`);
  return Number((data as GroupRow[] | null)?.[0]?.total_groups ?? 0);
}
