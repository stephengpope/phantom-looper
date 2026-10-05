-- "kind" is "type" everywhere: the work a model call was billed to is its
-- type — an agent type, or a helper (title, commit_message, compaction,
-- session_digest).
alter table phantom_looper.log_tokens rename column kind to type;
alter index if exists phantom_looper.log_tokens_kind_created_at_idx rename to log_tokens_type_created_at_idx;
