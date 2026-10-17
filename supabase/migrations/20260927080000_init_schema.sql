-- Email Automation System: core schema

create extension if not exists pgcrypto;

create table campaigns (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active' check (status in ('active', 'paused')),
  company_description text not null default '',
  value_props text not null default '',
  target_audience text not null default '',
  raw_template text not null default '',
  cta_link text not null default '',
  early_bird_line text not null default '',
  other_required_elements text[] not null default '{}',
  banned_phrases text[] not null default '{}',
  universal_image_url text,
  followup_day3_guidance text not null default '',
  followup_day7_guidance text not null default '',
  followup_day14_guidance text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  company text not null default '',
  title text not null default '',
  company_bio text not null default '',
  source text not null check (source in ('apollo', 'manual')),
  created_at timestamptz not null default now()
);

create table campaign_contacts (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  contact_id uuid not null references contacts(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'stopped', 'invalid', 'completed', 'generation_failed')),
  sequence_step smallint not null default 0 check (sequence_step in (0, 1, 2, 3)),
  next_send_at timestamptz not null default now(),
  last_sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (campaign_id, contact_id)
);

create table sends (
  id uuid primary key default gen_random_uuid(),
  campaign_contact_id uuid not null references campaign_contacts(id) on delete cascade,
  sequence_step smallint not null,
  subject text,
  body text,
  status text not null check (status in ('sent', 'failed')),
  provider_message_id text,
  error_message text,
  created_at timestamptz not null default now()
);

-- Dispatch query filters on exactly this pair.
create index idx_campaign_contacts_status_next_send on campaign_contacts (status, next_send_at);
create index idx_campaign_contacts_campaign on campaign_contacts (campaign_id);
create index idx_campaign_contacts_contact on campaign_contacts (contact_id);
create index idx_sends_campaign_contact on sends (campaign_contact_id);
create index idx_sends_created_at on sends (created_at desc);
create index idx_sends_status on sends (status);

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger campaigns_set_updated_at
  before update on campaigns
  for each row execute function set_updated_at();

-- RLS enabled with no policies: only the service_role key (used exclusively
-- by server-side backend code) can access these tables; anon/browser access
-- is denied by default.
alter table campaigns enable row level security;
alter table contacts enable row level security;
alter table campaign_contacts enable row level security;
alter table sends enable row level security;
