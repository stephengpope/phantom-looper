-- folders.claim_sha → cut_from_sha: the commit this checkout was cut from
-- (HEAD right after the branch was checked out — base's tip for a new
-- session, the source branch's tip for a duplicate). Its one reader counts
-- how far base has moved since (rev-list cut_from_sha..origin/base).
-- "claim" named the pool slot mechanism, not the fact.
alter table phantom_looper.folders rename column claim_sha to cut_from_sha;

-- Deleting a workspace deletes everything that was its. The board already
-- cascades (024); sessions, folders and loops still said `restrict`, so a
-- workspace with ANY session row — a destroyed one included — could not be
-- deleted at all (found by the folders proof: the route refuses only while
-- sessions are ACTIVE, then hit the FK and 500ed). Active sessions hold files
-- and containers; the route keeps refusing while any exist.
alter table phantom_looper.sessions drop constraint sessions_workspace_id_fkey,
  add constraint sessions_workspace_id_fkey foreign key (workspace_id)
    references phantom_looper.workspaces(id) on delete cascade;
alter table phantom_looper.folders drop constraint folders_workspace_id_fkey,
  add constraint folders_workspace_id_fkey foreign key (workspace_id)
    references phantom_looper.workspaces(id) on delete cascade;
alter table phantom_looper.loops drop constraint loops_workspace_id_fkey,
  add constraint loops_workspace_id_fkey foreign key (workspace_id)
    references phantom_looper.workspaces(id) on delete cascade;
