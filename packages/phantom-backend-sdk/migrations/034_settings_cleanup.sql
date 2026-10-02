-- `secret` was always equal to `value_enc is not null` — the CHECK from 001
-- forced it — so it was one fact stored twice. Readers ask the encrypted
-- column now. The secret-namespace shape rule (010) is restated without it.
alter table phantom_looper.settings drop constraint settings_enc_iff_secret;
alter table phantom_looper.settings drop constraint settings_secret_shape;
alter table phantom_looper.settings drop column secret;
alter table phantom_looper.settings add constraint settings_secret_shape
  check (namespace <> 'secret' or (value_enc is not null and value is not null));

-- The session layer is gone: one key allowed it and nothing ever wrote it.
-- Settings resolve default -> global -> workspace.
delete from phantom_looper.settings where scope like 'session:%';

-- Rows for keys the code no longer declares — set once, read by nothing
-- since the key went (the 004 rename, the compaction and assistant reworks).
delete from phantom_looper.settings
 where namespace = 'general'
   and key in ('git_fixer_provider', 'git_fixer_model', 'git_fixer_base_url',
               'auto_push_fix_attempts', 'assistant_history_limit',
               'compact_on_max_tokens', 'assistant_compact_on_max_tokens');
