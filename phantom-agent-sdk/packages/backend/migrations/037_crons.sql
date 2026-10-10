-- Crons: a workspace's scheduled prompts.
--
-- One row per scheduled prompt. The scheduler holds one croner timer per
-- enabled row (re-read from here every minute) that fires at its time — no
-- catch-up: a slot the server slept through never fires. A fire opens a NEW
-- coding session in the workspace (its own checkout, named after the cron,
-- seat 'cron'), runs the prompt as one coding turn, and closes it. The
-- session is the run's record.
--
-- Two kinds. RECURRING: `schedule` is a 5-field cron expression ("0 9 * * *")
-- and the row lives until removed. ONE-TIME (`once`): `schedule` is an ISO
-- datetime ("2026-03-14T18:50:00"), one moment ever; the row fires and is
-- deleted (or is deleted unfired when the server slept through its moment).
-- Both are read in the workspace's `cron_timezone`.
--
-- Addressed by name (unique per workspace, case-insensitively); the id is
-- storage's handle. Goes with its workspace.

create table phantom_looper.crons (
  id            bigint generated always as identity primary key,
  workspace_id  text not null references phantom_looper.workspaces(id) on delete cascade,
  name          text not null,
  schedule      text not null,
  once          boolean not null,
  prompt        text not null,
  enabled       boolean not null default true,
  last_run_at   timestamptz,   -- when it last fired; null = never
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create unique index crons_workspace_id_name_key on phantom_looper.crons (workspace_id, lower(name));
