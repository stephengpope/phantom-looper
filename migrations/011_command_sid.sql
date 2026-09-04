-- A detached command's process-session id, captured at spawn from a pidfile
-- the wrapper writes inside the container (runc setsids every exec, so the
-- leader's pid IS the sid of the whole tree). Container-namespace, never a
-- docker-top/host pid. Null until the capture lands, or when it failed —
-- readers must tolerate both. This is the join key between a commands row
-- and the live `ps` listing: exact task labeling, exact kill.
alter table phantom_looper.commands add column sid text;
