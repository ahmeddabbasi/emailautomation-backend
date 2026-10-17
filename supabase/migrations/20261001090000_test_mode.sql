-- Test mode compresses a list's follow-up schedule to minutes and ignores its
-- window/active days/daily cap, for live demos. Sends made while it's on are
-- real and counted, but flagged so analytics can filter them out.
alter table lead_lists add column test_mode boolean not null default false;
alter table sends add column test_mode boolean not null default false;
