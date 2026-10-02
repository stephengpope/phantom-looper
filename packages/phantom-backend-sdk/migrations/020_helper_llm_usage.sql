-- One row per helper LLM call — one-shot generateText calls that are not part
-- of any agent turn (session titles, commit messages). The coding and assistant
-- agents already record their usage on session rows; this table captures every
-- other model call so /status can account for 100% of LLM spend.
create table phantom_looper.helper_llm_usage (
  id          text primary key,
  kind        text not null,               -- 'title' | 'commit_message' | 'session_digest'
  session_id  text,                         -- the session this call served (nullable: a future helper may not belong to one)
  provider    text not null,
  model       text not null,
  system_prompt text,
  user_prompt   text,
  tokens_input       bigint not null default 0,
  tokens_output      bigint not null default 0,
  tokens_cache_read  bigint not null default 0,
  tokens_cache_write bigint not null default 0,
  created_at  timestamp with time zone not null default now()
);
