-- Public bucket for lead list images. The app uploads with the service key
-- and reads through public URLs, so no storage policies are needed.
insert into storage.buckets (id, name, public, file_size_limit)
values ('campaign-assets', 'campaign-assets', true, 5242880)
on conflict (id) do nothing;
