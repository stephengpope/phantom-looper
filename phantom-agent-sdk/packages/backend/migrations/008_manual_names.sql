-- /rename: a person's name for a session. name_manual marks it, and the
-- auto-titler (sessionTitle.ts) never writes over a manual name; renaming to
-- null clears both and hands the session back to the titler.
alter table phantom_looper.sessions add column name_manual boolean not null default false;
