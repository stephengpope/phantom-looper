// The git engine — a session branch's push, and the backup the disk sweeps
// run. No background git of its own: no tick, no commit timers, no periodic
// base merge. Work reaches base through auto-push (autoPush.ts) — on demand,
// or fired by instant sync (instantSync.ts) when a project opts in. `backup`
// is the ONE locked caller: the disk sweeps fire it unattended, so it holds
// the session lock, while a push relies on git's own index.lock to error a
// true simultaneous op.
import type { ProjectRow, SessionRow } from '../storage/schema.js';
import { git, commitAll, pushSession, GIT_CLIENT_ID, type PushResult, type GitAuth } from './Git.js';
import type { Sessions } from '../storage/Sessions.js';
import type { WorkspaceRow } from '../storage/schema.js';
import * as checkoutPool from '../runtime/CheckoutPool.js';
import { repoDir, type Paths } from '../lib/paths.js';
import { LOCK_TTL_MS, RENEW_MS, type SyncDeps } from './sync.js';
import { newId } from '@phantom-agent-sdk/client';
import { logger, errStr } from '../lib/log.js';

const log = logger('git');

export class GitSync {
  constructor(
    /** The SAME deps auto-push and auto-pull sync with — the row owners, the
     *  conflict resolver (the session's own coding agent) and the commit
     *  message model — so the system has one answer to every git question. */
    private deps: Omit<SyncDeps, 'onEvent' | 'recordSummary'>,
  ) {}

  private get sessions(): Sessions { return this.deps.sessions; }
  private get paths(): Paths { return this.deps.paths; }

  private auth(project: ProjectRow): Promise<GitAuth> { return checkoutPool.resolveAuth(this.deps.settings, project); }

  /** Git operates on WORKSPACES — the branch and the directory live there. A
   *  session with no workspace has nothing git-shaped to do. */
  private async workspaceOf(session: SessionRow): Promise<WorkspaceRow> {
    const workspace = session.workspaceId ? await this.deps.workspaces.get(session.workspaceId) : undefined;
    if (!workspace) throw new Error(`session ${session.id} has no workspace — nothing to push or pull`);
    return workspace;
  }

  /** BACKUP — the branch to origin and nothing else: commitAll + pushSession
   *  under the session lock, so the disk sweeps can fire it unattended. No
   *  rebase, no landing — main is never touched, and a later auto-push
   *  squashes these wip commits into its one real commit (the message is
   *  written from the whole diff, so backup messages never reach base).
   *  'busy' = the session is being driven; nothing was written.
   *
   *  `whenSafe` runs only when everything is on origin ('pushed' or
   *  'nothing'), STILL under the lock — the disk sweep deletes the files
   *  there, so no turn can start between the backup and the delete. */
  async backup(session: SessionRow, project: ProjectRow, whenSafe?: () => Promise<void>): Promise<PushResult | 'busy'> {
    if (!(await this.sessions.acquireLock(session, GIT_CLIENT_ID, LOCK_TTL_MS, 'backup'))) return 'busy';
    const heartbeat = setInterval(() => {
      void this.sessions.renewLock(session.id, GIT_CLIENT_ID, LOCK_TTL_MS)
        .catch((error) => log.warn({ session: session.id, err: errStr(error) }, 'backup lock renewal failed'));
    }, RENEW_MS);
    try {
      const pushed = await this.push(session, project);
      if (whenSafe && (pushed === 'pushed' || pushed === 'nothing')) await whenSafe();
      return pushed;
    } finally {
      clearInterval(heartbeat);
      await this.sessions.releaseLock(session.id, GIT_CLIENT_ID);
    }
  }

  /** commit -> push the branch this session is on. That is the whole of it:
   *  one branch, checked out at creation, pushed back to here. Porcelain inside
   *  commitAll is the authoritative dirty check. */
  async push(session: SessionRow, project: ProjectRow): Promise<PushResult | 'busy'> {
    const workspace = await this.workspaceOf(session);
    const dir = repoDir(this.paths, workspace.id);
    // The checkout lock: commit + push is a sequence too, and a sync may be
    // rewriting this checkout right now. Short, so no renewal.
    const holder = newId();
    if (!(await this.deps.workspaces.acquireSyncLock(workspace.id, holder, LOCK_TTL_MS))) return 'busy';
    try {
      const committed = await commitAll(dir, `phantom push ${new Date().toISOString()}\n\nPhantom-Session: ${session.id}`);
      const { stdout: ahead } = await git(dir, ['rev-list', '--count', `origin/${workspace.branch}..HEAD`]).catch(() => ({ stdout: '1' }));
      if (!committed && Number(ahead.trim()) === 0) return 'nothing';
      const pushed = await pushSession(dir, workspace.branch, await this.auth(project));
      if (pushed !== 'pushed') return pushed;
      await this.deps.workspaces.markPushed(workspace.id);
      log.info({ session: session.id, branch: workspace.branch }, 'pushed');
      return 'pushed';
    } catch (error) {
      log.error({ session: session.id, err: errStr(error) }, 'push failed');
      return { error: errStr(error) };
    } finally {
      await this.deps.workspaces.releaseSyncLock(workspace.id, holder);
    }
  }
}
