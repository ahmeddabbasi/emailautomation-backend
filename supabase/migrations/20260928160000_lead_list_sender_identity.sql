-- Per-list sender name/title, so the AI signs emails as a real person
-- instead of inventing one. Empty by default — a list with no sender_name
-- falls back to DEFAULT_SENDER_NAME at generation time (see
-- resolveSenderIdentity in src/lib/generation.ts), and generation is
-- blocked entirely if neither is set.
alter table lead_lists add column sender_name text not null default '';
alter table lead_lists add column sender_title text not null default '';
