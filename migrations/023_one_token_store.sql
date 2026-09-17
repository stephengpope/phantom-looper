-- token_usage (022) is the one store for every model call. The two it
-- replaced were still being written alongside it; they go now.
--   sessions.tokens_*      — the per-row running cache the assistant's turns
--                            added to (its calls now land in token_usage).
--   helper_llm_usage       — the one-shot helper calls' own table (022 copied
--                            every row into token_usage; nothing is lost).
alter table phantom_looper.sessions
  drop column if exists tokens_input,
  drop column if exists tokens_output,
  drop column if exists tokens_cache_read,
  drop column if exists tokens_cache_write,
  drop column if exists tokens_as_of;

drop table if exists phantom_looper.helper_llm_usage;
