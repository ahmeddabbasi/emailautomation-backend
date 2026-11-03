-- reverse: alter table app_settings drop constraint if exists app_settings_writer_preference_check;
-- reverse: alter table app_settings drop column if exists writer_preference;

alter table app_settings
  add column if not exists writer_preference text not null default 'auto';

alter table app_settings
  drop constraint if exists app_settings_writer_preference_check;

alter table app_settings
  add constraint app_settings_writer_preference_check
  check (writer_preference in ('auto', 'openai'));
