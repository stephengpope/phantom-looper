-- The checkout lock: one git sync writes a checkout at a time.
--
-- A sync — auto-push, auto-pull, the plain push — is a sequence of git
-- commands (fetch, add, commit, rebase, push). Git's own index.lock guards one
-- command, not the sequence: two syncs on one checkout interleave and wreck
-- the branch. The session lock did not prevent this: every sync took it under
-- one shared id, which the lock lets back in; and instant sync (a sync that
-- runs during a turn, by design) cannot take the session lock at all.
--
-- So the lock sits on the thing it guards, the folder (the checkout), with
-- the same two facts the session lock keeps: who holds it, until when. Taken
-- under a fresh id per run — never re-entered. Owned by Folders.
alter table phantom_looper.folders
  add column sync_locked_by text,
  add column sync_lock_expires_at timestamptz;
