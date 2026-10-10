-- One table: the transcript rejoins its session row. The transcripts table
-- existed for the (session_id, agent) dimension — two conversations on one
-- session — which migration 002 removed; since then it was strictly 1:1 with
-- sessions, a vestige. Reads simply must not SELECT the blob into lists
-- (db/schema.ts exports sessionColumns for exactly that).
--
-- Plus token accounting: the transcript's usage lines (one per model call —
-- see core/llm/transcript.ts) are the record; the tokens_* columns only CACHE
-- their sum, computed when the API is asked (GET /sessions/:id/token-usage)
-- and validated by tokens_as_of = transcript_updated_at.

alter table phantom_looper.sessions
  add column transcript            text,
  add column last_user_message     text,
  add column transcript_updated_at timestamptz,
  add column tokens_input          bigint,
  add column tokens_output         bigint,
  add column tokens_cache_read     bigint,
  add column tokens_cache_write    bigint,
  add column tokens_as_of          timestamptz;

update phantom_looper.sessions s
   set transcript            = t.data,
       last_user_message     = t.last_user_message,
       transcript_updated_at = t.updated_at
  from phantom_looper.transcripts t
 where t.session_id = s.id;

drop table phantom_looper.transcripts;
