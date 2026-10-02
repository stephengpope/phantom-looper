-- Session titles: `name` is a model-written title of what the session is
-- building (best-effort, written after a transcript save, never in it);
-- `turn_count` is the clock that paces it — +1 per transcript save, naming
-- fires at turn 1 while unnamed, then every 10th turn. A duplicated session
-- copies its name and starts the clock at 0.
alter table phantom_looper.sessions add column name text;
alter table phantom_looper.sessions add column turn_count integer not null default 0;
