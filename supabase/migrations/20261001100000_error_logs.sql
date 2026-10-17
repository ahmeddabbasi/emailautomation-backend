-- Every backend error and warning, routed through src/lib/logger.ts. Rows
-- with the same code + message share a fingerprint so a flood of one failure
-- reads as a single group in the Error Logs tab. Kept 30 days (purged by the
-- dispatch tick, see purgeOldErrorLogs).
create table error_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  level text not null check (level in ('error', 'warning')),
  source text not null,
  code text not null,
  message text not null,
  details jsonb not null default '{}'::jsonb,
  stack text,
  fingerprint text not null,
  resolved boolean not null default false,
  resolved_at timestamptz
);

create index idx_error_logs_created_at on error_logs (created_at desc);
create index idx_error_logs_fingerprint on error_logs (fingerprint, created_at desc);
create index idx_error_logs_unresolved on error_logs (level, fingerprint) where not resolved;

alter table error_logs enable row level security;

create or replace function error_log_groups(
  p_level text default null,
  p_source text default null,
  p_code text default null,
  p_resolved boolean default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_search text default null,
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  fingerprint text,
  level text,
  source text,
  code text,
  message text,
  occurrences bigint,
  unresolved bigint,
  first_seen timestamptz,
  last_seen timestamptz,
  total_groups bigint
)
language sql stable
as $$
  with filtered as (
    select * from error_logs e
    where (p_level is null or e.level = p_level)
      and (p_source is null or e.source = p_source)
      and (p_code is null or e.code = p_code)
      and (p_resolved is null or e.resolved = p_resolved)
      and (p_from is null or e.created_at >= p_from)
      and (p_to is null or e.created_at < p_to)
      and (
        p_search is null
        or e.message ilike '%' || p_search || '%'
        or e.code ilike '%' || p_search || '%'
        or e.details::text ilike '%' || p_search || '%'
      )
  ),
  grouped as (
    select
      f.fingerprint,
      (array_agg(f.level order by f.created_at desc))[1] as level,
      (array_agg(f.source order by f.created_at desc))[1] as source,
      (array_agg(f.code order by f.created_at desc))[1] as code,
      (array_agg(f.message order by f.created_at desc))[1] as message,
      count(*) as occurrences,
      count(*) filter (where not f.resolved) as unresolved,
      min(f.created_at) as first_seen,
      max(f.created_at) as last_seen
    from filtered f
    group by f.fingerprint
  )
  select g.*, count(*) over () as total_groups
  from grouped g
  order by g.last_seen desc
  limit p_limit offset p_offset;
$$;

alter function error_log_groups(text, text, text, boolean, timestamptz, timestamptz, text, int, int) set search_path = public;
revoke execute on function error_log_groups(text, text, text, boolean, timestamptz, timestamptz, text, int, int) from anon, authenticated;

create or replace function error_log_facets()
returns table (code text, source text)
language sql stable
set search_path = public
as $$
  select distinct e.code, e.source from error_logs e order by e.code;
$$;
revoke execute on function error_log_facets() from anon, authenticated;
