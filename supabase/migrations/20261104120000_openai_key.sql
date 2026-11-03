-- reverse: alter table app_settings drop column if exists openai_key_ciphertext;

alter table app_settings
  add column if not exists openai_key_ciphertext text not null default '';
