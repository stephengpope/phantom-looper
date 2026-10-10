-- The column holds a STATE — where the checkout's work stands against base
-- (not_pushed, not_merged, merged) — not the work. Named for what it is.
alter table phantom_looper.workspaces rename column work to work_state;
