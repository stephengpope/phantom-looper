-- transcript_lines is the count every write path keeps — the append route
-- (043) kept it; the whole-file saves (a turn end, a per-step save, a
-- duplicate) did not, so a record any earlier client touched carried a count
-- of 0 while holding lines. The append route's agreement check and the
-- `?after=N` read are both wrong on such a row. Every write path sets the
-- count from now on (sessions.ts lineCount); this brings the existing rows
-- to the truth once: the number of non-empty lines in the record.
update phantom_looper.sessions
   set transcript_lines = (
     select count(*) from unnest(string_to_array(transcript, E'\n')) as l where btrim(l) <> ''
   )
 where transcript is not null
   and transcript_lines = 0;
