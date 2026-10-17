-- One row of app-wide defaults that new lead lists prefill from.
create table app_settings (
  id boolean primary key default true check (id),
  default_cta_link text not null default '',
  default_early_bird_line text not null default '',
  updated_at timestamptz not null default now()
);
alter table app_settings enable row level security;

insert into app_settings (id, default_cta_link, default_early_bird_line)
values (
  true,
  'https://example.com/pricing',
  'The first 100 accounts get a founding price that stays locked for as long as you stay subscribed.'
);

-- Reports which of the given tables, functions and storage buckets are
-- missing, for /api/health.
create or replace function schema_check(p_tables text[], p_functions text[], p_buckets text[])
returns jsonb
language sql stable
set search_path = public
as $$
  select jsonb_build_object(
    'tables', coalesce((select jsonb_agg(t) from unnest(p_tables) t
      where not exists (select 1 from pg_tables where schemaname = 'public' and tablename = t)), '[]'::jsonb),
    'functions', coalesce((select jsonb_agg(f) from unnest(p_functions) f
      where not exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = f)), '[]'::jsonb),
    'buckets', coalesce((select jsonb_agg(b) from unnest(p_buckets) b
      where not exists (select 1 from storage.buckets where id = b)), '[]'::jsonb)
  );
$$;
revoke execute on function schema_check(text[], text[], text[]) from anon, authenticated;
