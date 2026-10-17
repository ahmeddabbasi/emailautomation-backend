-- Additive: Zoho mailboxes, HTML templates, suppressions, and CSV import jobs.
-- Existing Mailgun dispatch, AI copy, and lead-list scheduling stay in place.

alter table contacts add column if not exists first_name text not null default '';
alter table contacts add column if not exists last_name text not null default '';
alter table contacts add column if not exists custom_fields jsonb not null default '{}'::jsonb;

alter table campaigns add column if not exists schedule_start_at timestamptz;

alter table lead_lists alter column campaign_id drop not null;

alter table campaign_contacts drop constraint if exists campaign_contacts_status_check;
alter table campaign_contacts add constraint campaign_contacts_status_check
  check (status in (
    'queued', 'pending', 'stopped', 'invalid', 'completed',
    'generation_failed', 'replied', 'complained', 'unsubscribed'
  ));

create table if not exists suppressions (
  email text primary key,
  reason text not null default 'unsubscribed',
  created_at timestamptz not null default now()
);

create table if not exists mailboxes (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  email text not null,
  smtp_host text not null,
  smtp_port int not null check (smtp_port > 0 and smtp_port <= 65535),
  smtp_security text not null check (smtp_security in ('ssl', 'starttls')),
  username text not null,
  password_ciphertext text not null,
  imap_host text,
  imap_port int check (imap_port is null or (imap_port > 0 and imap_port <= 65535)),
  reply_to text,
  signature_html text not null default '',
  daily_limit int not null check (daily_limit >= 1 and daily_limit <= 30),
  hourly_limit int not null check (hourly_limit >= 1),
  status text not null default 'paused' check (status in ('active', 'paused', 'error')),
  last_error text,
  auth_failure_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mailbox_hourly_within_daily check (hourly_limit <= daily_limit)
);

create trigger mailboxes_set_updated_at
  before update on mailboxes
  for each row execute function set_updated_at();

-- A mailbox belongs to at most one campaign. A campaign can have many.
create table if not exists campaign_mailboxes (
  campaign_id uuid not null references campaigns(id) on delete cascade,
  mailbox_id uuid not null unique references mailboxes(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (campaign_id, mailbox_id)
);

create table if not exists mailbox_sends (
  id uuid primary key default gen_random_uuid(),
  mailbox_id uuid not null references mailboxes(id) on delete cascade,
  sent_at timestamptz not null default now()
);

create index if not exists idx_mailbox_sends_mailbox_sent on mailbox_sends (mailbox_id, sent_at desc);

alter table sends add column if not exists mailbox_id uuid references mailboxes(id) on delete set null;

-- One HTML template per sequence step. Absent step keeps the AI generator.
create table if not exists email_templates (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  name text not null default '',
  sequence_step smallint not null check (sequence_step in (0, 1, 2, 3)),
  subject text not null default '',
  html_body text not null default '',
  text_body text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, sequence_step)
);

create trigger email_templates_set_updated_at
  before update on email_templates
  for each row execute function set_updated_at();

create table if not exists import_jobs (
  id uuid primary key default gen_random_uuid(),
  lead_list_id uuid not null references lead_lists(id) on delete cascade,
  source text not null check (source in ('apollo', 'manual')),
  status text not null default 'pending' check (status in ('pending', 'running', 'completed', 'failed')),
  total_rows int not null default 0,
  imported int not null default 0,
  duplicates int not null default 0,
  invalid_count int not null default 0,
  rows jsonb not null default '[]'::jsonb,
  mapping jsonb not null default '{}'::jsonb,
  invalid_rows jsonb not null default '[]'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_import_jobs_status on import_jobs (status, created_at);

create trigger import_jobs_set_updated_at
  before update on import_jobs
  for each row execute function set_updated_at();

alter table suppressions enable row level security;
alter table mailboxes enable row level security;
alter table campaign_mailboxes enable row level security;
alter table mailbox_sends enable row level security;
alter table email_templates enable row level security;
alter table import_jobs enable row level security;
