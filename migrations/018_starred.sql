-- A starred session pins to the top of every session list (the cli's /resume,
-- telegram's /sessions). One flag on the row; the list orders by it before
-- recency, and the page cursor carries it (before_starred) so starred rows
-- never leak into later pages.
alter table phantom_looper.sessions add column starred boolean not null default false;
