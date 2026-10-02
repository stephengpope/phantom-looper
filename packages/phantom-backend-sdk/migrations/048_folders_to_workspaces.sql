-- Rename: a checkout — files on disk, a branch, a container — is a WORKSPACE
-- (was "folder"). Pass 2 of the naming change (docs/phantom-agent-sdk-plan.md
-- §1; 047 was pass 1). The table, the one column that points at it, and the
-- constraints and indexes named after them.

alter table phantom_looper.folders rename to workspaces;
alter table phantom_looper.sessions rename column folder_id to workspace_id;

do $$
declare r record;
begin
  for r in
    select c.conname, c.conrelid::regclass as rel
      from pg_constraint c join pg_namespace n on n.oid = c.connamespace
     where n.nspname = 'phantom_looper' and c.conname like '%folder%'
  loop
    execute format('alter table %s rename constraint %I to %I', r.rel, r.conname, replace(r.conname, 'folder', 'workspace'));
  end loop;
  for r in
    select indexname from pg_indexes
     where schemaname = 'phantom_looper' and indexname like '%folder%'
  loop
    execute format('alter index phantom_looper.%I rename to %I', r.indexname, replace(r.indexname, 'folder', 'workspace'));
  end loop;
end $$;
