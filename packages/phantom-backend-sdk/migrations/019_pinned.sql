-- The star is a pin: the flag 018 added settled on pin (/pin in the cli and
-- telegram, [p] on /resume). Rename only — a pinned session still sits at
-- the top of every session list, ahead of recency, and the page cursor
-- carries it (before_pinned) so pinned rows never leak into later pages.
alter table phantom_looper.sessions rename column starred to pinned;
