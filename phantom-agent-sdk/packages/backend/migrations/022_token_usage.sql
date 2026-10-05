-- One row per LLM call — agent steps AND helper calls in the same table.
-- Replaces the session row's tokens_* cache columns and the helper_llm_usage
-- table as the single source of truth for all token spend.
create table phantom_looper.token_usage (
  id             text primary key,
  session_id     text,                          -- the session this call belongs to (nullable for future non-session calls)
  kind           text not null,                  -- 'coding' | 'supervisor' | 'assistant' | 'title' | 'commit_message' | 'compaction' | 'session_digest'
  provider       text,
  model          text,
  response_id    text,                           -- provider's response id (e.g. msg_...) — null for interrupted steps or helpers that don't return one
  tokens_input       bigint not null default 0,
  tokens_output      bigint not null default 0,
  tokens_cache_read  bigint not null default 0,
  tokens_cache_write bigint not null default 0,
  created_at     timestamp with time zone not null default now()
);

create index token_usage_session_id_idx on phantom_looper.token_usage (session_id);
create index token_usage_created_at_idx on phantom_looper.token_usage (created_at);
create index token_usage_kind_created_at_idx on phantom_looper.token_usage (kind, created_at);

-- Backfill from helper_llm_usage into the new table.
insert into phantom_looper.token_usage (id, session_id, kind, provider, model, response_id,
  tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, created_at)
select id, session_id, kind, provider, model, null,
  tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, created_at
from phantom_looper.helper_llm_usage;
