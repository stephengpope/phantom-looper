-- Secrets: user-named tokens the coding agent can read (list + get; the cli
-- adds and deletes). Same table as settings — a NAMESPACE column separates
-- them, 'general' being everything that existed before, part of the primary
-- key so the same name can exist in both worlds without touching the other.
--
-- A secret row is ONE row: the token encrypted in value_enc, the description
-- in plain value ({description}) — so listing secrets never decrypts. The
-- one-value CHECK is relaxed for the secret namespace only; 'general' rows
-- keep the original either/or rule exactly.
alter table phantom_looper.settings
  add column namespace text not null default 'general';

alter table phantom_looper.settings drop constraint settings_pkey;
alter table phantom_looper.settings add primary key (scope, namespace, key);

alter table phantom_looper.settings drop constraint settings_one_value;
alter table phantom_looper.settings add constraint settings_one_value
  check (namespace = 'secret' or (value is null) <> (value_enc is null));
-- A secret-namespace row always has both halves, and is always encrypted.
alter table phantom_looper.settings add constraint settings_secret_shape
  check (namespace <> 'secret' or (secret and value_enc is not null and value is not null));
