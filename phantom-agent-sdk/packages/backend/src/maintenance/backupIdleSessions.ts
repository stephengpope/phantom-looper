// backup_idle_sessions — the AUTOMATIC BACKUP: an idle session's work is
// pushed to its branch on origin (gitSync.backup: commit + push, never a
// rebase or a landing). After it, nothing exists only on a disk, and
// reopening a deleted session re-clones the branch with its work in it.
import type { Projects } from '../storage/Projects.js';
import type { Sessions } from '../storage/Sessions.js';
import type { GitSync } from '../git/GitSync.js';
import type { MaintenanceJob } from './Maintenance.js';
import { workspaceOwners } from './owners.js';
import { logger, errStr } from '../lib/log.js';

const log = logger('backup');

/** Idle-backup gates: worth it only once a session has real work (turns), and
 *  only after a short quiet spell so the common case is one backup per work
 *  session, not one per coffee sip — with the lock itself as the final check
 *  when the clock lies (one 2-hour command inside a single tool call updates
 *  nothing until it ends, but the running turn HOLDS the lock, so the backup
 *  reads busy). 5 minutes keeps unpushed work on quiet sessions minutes
 *  stale, not hours. */
const BACKUP_MIN_TURNS = 10;
const BACKUP_IDLE_MS = 5 * 60_000;

/** Push every quiet session's work to its branch, so time itself can never
 *  strand work that exists only on a disk. The gate
 *  `lastPushAt < lastUsedAt` means a session with nothing new since its last
 *  push is never touched — the common case costs no lock, no git, no push. */
export function backupIdleSessions(deps: { projects: Projects; sessions: Sessions; gitSync: GitSync }): MaintenanceJob {
  return {
    name: 'backup_idle_sessions',
    description: 'Pushes an idle session\'s unpushed work to its branch, so nothing exists only on a runner\'s disk.',
    where: 'session runners',
    async run() {
      const owners = await workspaceOwners(deps.projects, deps.sessions);
      const now = Date.now();
      let pushed = 0;
      for (const { session, project } of owners) {
        if (session.turnCount < BACKUP_MIN_TURNS) continue;
        if (now - session.lastUsedAt.getTime() < BACKUP_IDLE_MS) continue;
        if (session.lastPushAt && session.lastPushAt.getTime() >= session.lastUsedAt.getTime()) continue;
        const result = await deps.gitSync.backup(session, project).catch((error) => {
          log.warn({ session: session.id, err: errStr(error) }, 'backup failed');
          return { error: errStr(error) };
        });
        if (result === 'pushed') { pushed++; log.info({ session: session.id }, 'idle session backed up'); }
      }
      return { pushed };
    },
  };
}
