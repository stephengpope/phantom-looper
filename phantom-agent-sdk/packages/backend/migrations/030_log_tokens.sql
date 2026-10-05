-- `token_usage` read like a total you look up; it is a log — one entry
-- appended per model call, by sessions and helpers alike. Named for what it
-- is. Indexes follow so `\d` reads true.
alter table phantom_looper.token_usage rename to log_tokens;
alter index phantom_looper.token_usage_pkey rename to log_tokens_pkey;
alter index phantom_looper.token_usage_session_id_idx rename to log_tokens_session_id_idx;
alter index phantom_looper.token_usage_created_at_idx rename to log_tokens_created_at_idx;
alter index phantom_looper.token_usage_kind_created_at_idx rename to log_tokens_kind_created_at_idx;
