-- Who drove a session's last turn, as a user (059 gave every session the
-- user who started it). `last_turn_by` stays what TYPE of driver it was — a
-- person, or an automation's name (cron, looper) — and a user's own request
-- is always a person; this is WHICH user, stamped from the request, never
-- from a header. Null: the operator, an automation acting for no one, or a
-- user since deleted.
alter table phantom_agent_sdk.sessions
  add column last_turn_user_id text references identity."user"(id) on delete set null;
