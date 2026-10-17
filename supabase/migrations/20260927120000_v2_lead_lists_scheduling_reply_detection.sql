-- v2 rebuild: lead lists own targeting/template/scheduling config, reply
-- detection, idempotent test sends, auth + ops tables.

create table lead_lists (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references campaigns(id) on delete cascade,
  name text not null,
  source text not null check (source in ('apollo', 'manual')),
  status text not null default 'active' check (status in ('active', 'paused')),

  industry text not null default '',
  target_audience text not null default '',
  raw_subject_structure text not null default '',
  raw_email_structure text not null default '',
  cta_link text not null default '',
  early_bird_line text not null default '',
  other_required_elements text[] not null default '{}',
  banned_phrases text[] not null default '{}',
  universal_image_url text,
  followup_day3_guidance text not null default '',
  followup_day7_guidance text not null default '',
  followup_day14_guidance text not null default '',
  followup_offsets_days int[] not null default '{3,7,14}',

  timezone text not null default 'UTC',
  daily_cap int not null default 20 check (daily_cap > 0),
  window_start_minutes int not null default 540 check (window_start_minutes >= 0 and window_start_minutes < 1440),
  window_end_minutes int not null default 1080 check (window_end_minutes > 0 and window_end_minutes <= 1440),
  drip_batch_size int not null default 5 check (drip_batch_size > 0),
  drip_interval_minutes int not null default 180 check (drip_interval_minutes > 0),
  active_days smallint[] not null default '{1,2,3,4,5}',

  generation_status text not null default 'pending' check (generation_status in ('pending', 'running', 'completed')),
  generation_total int not null default 0,
  generation_completed int not null default 0,
  generation_failed_count int not null default 0,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint window_valid check (window_end_minutes > window_start_minutes)
);

create index idx_lead_lists_campaign on lead_lists (campaign_id);

create trigger lead_lists_set_updated_at
  before update on lead_lists
  for each row execute function set_updated_at();

-- Backfill: one lead_list per existing campaign, carrying over its current
-- template/rules fields, so existing campaign_contacts have somewhere to
-- attach to before campaign_id is dropped from that table.
insert into lead_lists (
  id, campaign_id, name, source, raw_email_structure, cta_link, early_bird_line,
  other_required_elements, banned_phrases, universal_image_url,
  followup_day3_guidance, followup_day7_guidance, followup_day14_guidance,
  target_audience, generation_status, generation_total, generation_completed
)
select
  gen_random_uuid(), c.id, c.name || ' — migrated list', 'manual', c.raw_template, c.cta_link, c.early_bird_line,
  c.other_required_elements, c.banned_phrases, c.universal_image_url,
  c.followup_day3_guidance, c.followup_day7_guidance, c.followup_day14_guidance,
  c.target_audience, 'completed',
  (select count(*) from campaign_contacts cc where cc.campaign_id = c.id),
  (select count(*) from campaign_contacts cc where cc.campaign_id = c.id)
from campaigns c;

alter table campaign_contacts add column lead_list_id uuid references lead_lists(id) on delete cascade;

update campaign_contacts cc
set lead_list_id = ll.id
from lead_lists ll
where ll.campaign_id = cc.campaign_id;

alter table campaign_contacts alter column lead_list_id set not null;

alter table campaign_contacts drop constraint campaign_contacts_campaign_id_contact_id_key;
alter table campaign_contacts drop constraint campaign_contacts_campaign_id_fkey;
alter table campaign_contacts drop column campaign_id;
alter table campaign_contacts add constraint campaign_contacts_lead_list_contact_key unique (lead_list_id, contact_id);

alter table campaigns drop column raw_template;
alter table campaigns drop column cta_link;
alter table campaigns drop column early_bird_line;
alter table campaigns drop column other_required_elements;
alter table campaigns drop column banned_phrases;
alter table campaigns drop column universal_image_url;
alter table campaigns drop column followup_day3_guidance;
alter table campaigns drop column followup_day7_guidance;
alter table campaigns drop column followup_day14_guidance;
alter table campaigns drop column target_audience;

alter table campaign_contacts drop constraint campaign_contacts_status_check;
alter table campaign_contacts add constraint campaign_contacts_status_check
  check (status in ('queued', 'pending', 'stopped', 'invalid', 'completed', 'generation_failed', 'replied', 'complained'));

alter table campaign_contacts add column locked_at timestamptz;
alter table campaign_contacts add column initial_subject text;
alter table campaign_contacts add column initial_body text;

create index idx_campaign_contacts_lead_list_status_next_send
  on campaign_contacts (lead_list_id, status, next_send_at);

drop index idx_campaign_contacts_status_next_send;

create table replies (
  id uuid primary key default gen_random_uuid(),
  campaign_contact_id uuid not null references campaign_contacts(id) on delete cascade,
  received_at timestamptz not null default now(),
  subject text,
  body_snippet text,
  created_at timestamptz not null default now()
);

create index idx_replies_campaign_contact on replies (campaign_contact_id);

alter table sends alter column campaign_contact_id drop not null;
alter table sends add column is_test boolean not null default false;
alter table sends add column test_recipient_email text;

-- Idempotency: at most one successful (real, non-test) send per contact per
-- step, enforced at the DB level so an overlapping/retried cron tick can
-- never double-send.
create unique index idx_sends_one_success_per_step
  on sends (campaign_contact_id, sequence_step)
  where status = 'sent' and is_test = false;

create index idx_sends_is_test on sends (is_test);

create table login_attempts (
  key text primary key,
  count int not null default 0,
  window_start timestamptz not null default now()
);

create table cron_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  processed int not null default 0,
  sent int not null default 0,
  failed int not null default 0,
  generation_failed int not null default 0,
  error_message text,
  details jsonb
);

create index idx_cron_runs_started_at on cron_runs (started_at desc);

alter table lead_lists enable row level security;
alter table replies enable row level security;
alter table login_attempts enable row level security;
alter table cron_runs enable row level security;
