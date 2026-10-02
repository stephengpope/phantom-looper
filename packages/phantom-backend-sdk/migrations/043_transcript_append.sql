-- The transcript is appended to, one typed JSON line at a time, by whoever
-- holds the session (POST /sessions/:id/transcript/append). Two facts make
-- an append safe over a network that loses replies:
--
--   transcript_lines     how many lines the record holds. A writer says how
--                        many it believes there are (`after`); the append
--                        lands only if they agree — otherwise someone else
--                        wrote, and the writer must read again.
--   transcript_delivery  the id of the last append that landed. A writer
--                        whose reply was lost resends with the same id and
--                        is told it already landed — no duplicate line.
--
-- Sessions written before this carry their whole-file transcript with a
-- count of 0; the conversion of those records is a separate step.
alter table phantom_looper.sessions
  add column transcript_lines    integer not null default 0,
  add column transcript_delivery text;
