-- A hard bounce arrives after Mailgun already accepted the message, so the
-- send stays status='sent' (it still counts toward daily volume and the
-- idempotency index) but is flagged here as never delivered. Analytics
-- counts these as send failures and excludes them from the funnel.
alter table sends add column delivery_failed_at timestamptz;
create index idx_sends_provider_message_id on sends (provider_message_id);
