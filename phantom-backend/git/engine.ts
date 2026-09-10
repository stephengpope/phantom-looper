// The git engine — the MANUAL operations (/git/push, /git/pull, /git/status).
// There is no background git any more: no watcher, no tick, no commit timers,
// no periodic base merge. Work reaches base through auto-push (autoPush.ts);
// push and pull remain as explicit calls. `backup` is the ONE locked caller:
// the disk sweeps fire it unattended, so it holds the session lock while a
// person-driven push/pull relies on git's own index.lock to error a true
// simultaneous op.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions, type WorkspaceRow, type SessionRow } from '../db/schema.js';
import { git, commitAll, pushSession, GIT_CLIENT_ID, type PushResult, type PullResult, type GitAuth } from './git.js';
import { getFolder, acquireLock, releaseLock, renewLock } from '../sessions.js';
import type { FolderRow } from '../db/schema.js';
import { resolveAuth } from '../pool/pool.js';
import { repoDir, type Paths } from '../pool/paths.js';
import { syncBranch, LOCK_TTL_MS, RENEW_MS, type ConflictContext, type SyncDeps } from './sync.js';
import { logger, errStr } from '../log.js';

const log = logger('git');

/** What arrived from base at each pull — the buffer the status view serves
 *  alongside its live diff. In-memory: it is a convenience view over
 *  git history, not a record. */
export interface Arrival { at: number; commits: string[] }

export class GitEngine {
  private arrivals = new Map<string, Arrival[]>();

  constructor(
    private db: Db,
    private paths: Paths,
    private encryptionKey: Buffer,
    /** Hand a stopped merge to the session's own coding agent — the same hook
     *  auto-push and auto-pull use. Runs over a tree whose merge is still in
     *  progress; resolves + commits, holding no credentials, and the engine
     *  verifies and pushes afterward. Absent -> conflicts abort. */
    private resolveConflict?: (
      session: SessionRow, workspace: WorkspaceRow, dir: string, ctx: ConflictContext,
    ) => Promise<boolean>,
    /** Model for the pull's commit message — the same one auto-push and
     *  auto-pull use. Absent -> a pull with work to commit fails with the
     *  reason; there is no file-name fallback anywhere. */
    private messageConfig?: SyncDeps['messageConfig'],
  ) {}

  async detach(sessionId: string): Promise<void> {
    this.arrivals.delete(sessionId);
  }

  private auth(workspace: WorkspaceRow): Promise<GitAuth> { return resolveAuth(this.db, workspace, this.encryptionKey); }

  /** Git operates on FOLDERS — the branch and the directory live there. A
   *  session with no folder has nothing git-shaped to do. */
  private async folderOf(s: SessionRow): Promise<FolderRow> {
    const folder = s.folderId ? await getFolder(this.db, s.folderId) : undefined;
    if (!folder) throw new Error(`session ${s.id} has no folder — nothing to push or pull`);
    return folder;
  }

  /** BACKUP — the branch to origin and nothing else: commitAll + pushSession
   *  under the session lock, so the disk sweeps can fire it unattended. No
   *  rebase, no landing — main is never touched, and a later auto-push
   *  squashes these wip commits into its one real commit (the message is
   *  written from the whole diff, so backup messages never reach base).
   *  'busy' = the session is being driven; nothing was written. */
  async backup(s: SessionRow, workspace: WorkspaceRow): Promise<PushResult | 'busy'> {
    if (!(await acquireLock(this.db, s, GIT_CLIENT_ID, LOCK_TTL_MS, 'backup'))) return 'busy';
    const heartbeat = setInterval(() => {
      void renewLock(this.db, s.id, GIT_CLIENT_ID, LOCK_TTL_MS)
        .catch((e) => log.warn({ session: s.id, err: errStr(e) }, 'backup lock renewal failed'));
    }, RENEW_MS);
    try {
      return await this.push(s, workspace);
    } finally {
      clearInterval(heartbeat);
      await releaseLock(this.db, s.id, GIT_CLIENT_ID);
    }
  }

  /** commit -> push the branch this session is on. That is the whole of it:
   *  one branch, checked out at creation, pushed back to here. Porcelain inside
   *  commitAll is the authoritative dirty check. */
  async push(s: SessionRow, workspace: WorkspaceRow): Promise<PushResult> {
    const folder = await this.folderOf(s);
    const dir = repoDir(this.paths, folder.id);
    try {
      const committed = await commitAll(dir, `phantom push ${new Date().toISOString()}\n\nPhantom-Session: ${s.id}`);
      const { stdout: ahead } = await git(dir, ['rev-list', '--count', `origin/${folder.branch}..HEAD`]).catch(() => ({ stdout: '1' }));
      if (!committed && Number(ahead.trim()) === 0) return 'nothing';
      const r = await pushSession(dir, folder.branch, await this.auth(workspace));
      if (r !== 'pushed') return r;
      await this.db.update(sessions).set({ lastPushAt: new Date() }).where(eq(sessions.id, s.id));
      log.info({ session: s.id, branch: folder.branch }, 'pushed');
      return 'pushed';
    } catch (e) {
      log.error({ session: s.id, err: errStr(e) }, 'push failed');
      return 'error';
    }
  }

  /** Bring origin/<base> under this session's work and push the branch, so the
   *  remote copy is always complete. This is `syncBranch` without the landing —
   *  the SAME flow auto-push and auto-pull run, so the system has one answer to
   *  "get base's new commits under my work", not three. Nothing reaches base.
   *
   *  It takes the session (sync does), which is why `busy` is a result here. */
  async pull(s: SessionRow, workspace: WorkspaceRow): Promise<PullResult | 'busy'> {
    const r = await syncBranch(
      { db: this.db, paths: this.paths, encryptionKey: this.encryptionKey,
        resolve: this.resolveConflict, messageConfig: this.messageConfig },
      s, workspace, { landOnBase: false, label: 'pull' });
    if (r.outcome === 'ok') {
      const list = this.arrivals.get(s.id) ?? [];
      list.push({ at: Date.now(), commits: r.arrived ?? [] });
      this.arrivals.set(s.id, list.slice(-20));
      log.info({ session: s.id, commits: r.arrived?.length }, 'pulled base');
      return 'merged';
    }
    if (r.outcome === 'nothing') return 'clean';
    if (r.outcome === 'busy') return 'busy';
    if (r.outcome === 'blocked') {
      log.warn({ session: s.id, reason: r.reason }, 'pull conflict unresolved — the branch is as it was');
      return 'conflict';
    }
    return 'error';
  }

  /** What moved on base — read-only, changes nothing in the tree. */
  async status(s: SessionRow, workspace: WorkspaceRow): Promise<{
    pending: { commits: string[]; files: string[] };
    sinceClaim: number;
    pulled: Arrival[];
  }> {
    const folder = await this.folderOf(s);
    const dir = repoDir(this.paths, folder.id);
    await git(dir, ['fetch', 'origin', workspace.baseBranch], await this.auth(workspace)).catch((e: Error) => {
      log.warn({ dir, base: workspace.baseBranch, err: e.message }, 'fetch of base failed — arrivals are measured against the last copy');
    });
    const { stdout: commits } = await git(dir, ['log', '--format=%h %s', `HEAD..origin/${workspace.baseBranch}`]).catch(() => ({ stdout: '' }));
    const { stdout: files } = await git(dir, ['diff', '--name-only', `HEAD...origin/${workspace.baseBranch}`]).catch(() => ({ stdout: '' }));
    const { stdout: since } = await git(dir, ['rev-list', '--count', `${folder.claimSha}..origin/${workspace.baseBranch}`]).catch(() => ({ stdout: '0' }));
    return {
      pending: {
        commits: commits.trim().split('\n').filter(Boolean),
        files: files.trim().split('\n').filter(Boolean),
      },
      sinceClaim: Number(since.trim()),
      pulled: this.arrivals.get(s.id) ?? [],
    };
  }
}
