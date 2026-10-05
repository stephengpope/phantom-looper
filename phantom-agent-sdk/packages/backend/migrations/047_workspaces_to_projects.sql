-- Rename: a registered repo is a PROJECT (was "workspace"). Pass 1 of the
-- naming change (docs/phantom-agent-sdk-plan.md §1); pass 2 renames folders
-- to workspaces. Everything live that carries the old word moves here: the
-- table, its foreign-key columns, the constraints and indexes named after
-- them, the settings scope values, the one setting key, and the agents'
-- per-project databases and roles.

alter table phantom_looper.workspaces rename to projects;

alter table phantom_looper.cards rename column workspace_id to project_id;
alter table phantom_looper.folders rename column workspace_id to project_id;
alter table phantom_looper.sessions rename column workspace_id to project_id;
alter table phantom_looper.crons rename column workspace_id to project_id;
alter table phantom_looper.telegram_bot_state rename column active_workspace_id to active_project_id;

-- Constraints and indexes keep their names through a table/column rename;
-- rename every one in the schema that says "workspace" so a name never
-- contradicts what it is on.
do $$
declare r record;
begin
  for r in
    select c.conname, c.conrelid::regclass as rel
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace
     where n.nspname = 'phantom_looper' and c.conname like '%workspace%'
  loop
    execute format('alter table %s rename constraint %I to %I', r.rel, r.conname, replace(r.conname, 'workspace', 'project'));
  end loop;
  for r in
    select indexname from pg_indexes
     where schemaname = 'phantom_looper' and indexname like '%workspace%'
  loop
    execute format('alter index phantom_looper.%I rename to %I', r.indexname, replace(r.indexname, 'workspace', 'project'));
  end loop;
end $$;

-- Settings: the per-project scope and the one key that named it.
update phantom_looper.settings set scope = 'project:' || substr(scope, 11) where scope like 'workspace:%';
update phantom_looper.settings set key = 'boot_last_project' where key = 'boot_last_workspace';

-- The agents' own databases and roles: `workspace_<id>` -> `project_<id>`.
-- Proven on Postgres 16: both renames run inside a transaction, the SCRAM
-- password survives a role rename. A database being renamed must have no
-- other connections (CloudBeaver may hold one): end them first.
do $$
declare r record;
begin
  for r in select datname from pg_database where datname like 'workspace\_%' loop
    perform pg_terminate_backend(pid) from pg_stat_activity where datname = r.datname and pid <> pg_backend_pid();
    execute format('alter database %I rename to %I', r.datname, 'project_' || substr(r.datname, 11));
  end loop;
  for r in select rolname from pg_roles where rolname like 'workspace\_%' loop
    execute format('alter role %I rename to %I', r.rolname, 'project_' || substr(r.rolname, 11));
  end loop;
end $$;
