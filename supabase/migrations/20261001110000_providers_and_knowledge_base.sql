-- Which model provider wrote each email. Initial drafts are generated ahead
-- of time, so the provider is kept on the draft and copied to its send row.
alter table sends add column provider text;
alter table campaign_contacts add column initial_provider text;

-- Company knowledge base: uploaded documents, fetched links, and typed facts.
-- Only extracted text is used for generation; files stay in Storage for
-- reference.
create table knowledge_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  kind text not null check (kind in ('document', 'link', 'facts')),
  doc_type text not null default 'other'
    check (doc_type in ('company_profile', 'product', 'pricing', 'terms', 'privacy', 'case_studies', 'other')),
  title text not null,
  enabled boolean not null default true,
  file_path text,
  file_name text,
  mime_type text,
  size_bytes integer,
  url text,
  last_fetched_at timestamptz,
  extracted_text text not null default '',
  extraction_status text not null default 'ok' check (extraction_status in ('ok', 'empty', 'failed')),
  extraction_error text
);
create unique index knowledge_items_single_facts on knowledge_items (kind) where kind = 'facts';
alter table knowledge_items enable row level security;

-- The condensed company brief actually injected into every email prompt.
-- Each regeneration or manual edit adds a new version; exactly one is active.
create table company_briefs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  version integer not null,
  content text not null,
  source_hash text not null,
  origin text not null check (origin in ('generated', 'edited')),
  provider text,
  is_active boolean not null default false
);
create unique index company_briefs_version on company_briefs (version);
create unique index company_briefs_single_active on company_briefs (is_active) where is_active;
alter table company_briefs enable row level security;

insert into storage.buckets (id, name, public, file_size_limit)
values ('knowledge-base', 'knowledge-base', false, 10485760)
on conflict (id) do nothing;
