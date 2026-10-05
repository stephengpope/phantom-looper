-- Who drove the LAST turn on a session — the actor the turn's client declared
-- (x-phantom-looper-actor; a person when unsaid). started_by stays what it
-- says: who opened the session. A default listing hides a background opener's
-- session only while a background actor was the last to drive it, so a
-- cron's session a person then worked in is the person's to see. Null until
-- a turn ends.
alter table phantom_looper.sessions add column last_turn_by text;
