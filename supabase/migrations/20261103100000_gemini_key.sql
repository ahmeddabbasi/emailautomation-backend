alter table app_settings
  add column if not exists gemini_key_ciphertext text not null default '';
