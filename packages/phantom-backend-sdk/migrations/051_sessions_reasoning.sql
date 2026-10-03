-- The row's model pin carries its reasoning level too: a cron that names one
-- (crons.reasoning) stamps it on the session it opens, and turn-start reads
-- the whole pin off the row — nothing rides in-process any more.
alter table phantom_looper.sessions add column reasoning text;
