// The git engine — the MANUAL operations (/git/push, /git/pull, /git/status).
// There is no background git any more: no watcher, no tick, no commit timers,
// no periodic base merge. Work reaches base through auto-push (autoPush.ts);
// push and pull remain as explicit calls. No lock anywhere: one user drives
// these, and a true simultaneous git op errors on git's own index.lock.
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions, type WorkspaceRow, type SessionRow } from '../db/schema.js';
import { git, commitAll, pushSession, mergeBase, type PushResult, type PullResult, type GitAuth } from './git.js';
import { getFolder } from '../sessions.js';
import type { FolderRow } from '../db/schema.js';
import { resolveAuth } from '../pool/pool.js';
import { repoDir, type Paths } from '../pool/paths.js';
import { verifyResolved } from './gitFixer.js';
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
    /** Conflict agent hook. Runs over a tree whose merge is still in
     *  progress. Resolves + commits, no credentials; the engine verifies and
     *  pushes afterward. Absent -> conflicts abort. */
    private gitFixer?: (session: SessionRow, workspace: WorkspaceRow, dir: string) => Promise<boolean>,
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

  /** Merge origin/<base> into the branch this session is on, then push it so
   *  the remote copy is always complete. When the session IS on base this is
   *  the ordinary catch-up merge; when it is on its own branch it is what keeps
   *  the branch mergeable. Either way the push goes to s.branch and nowhere
   *  else. */
  async pull(s: SessionRow, workspace: WorkspaceRow): Promise<PullResult> {
    const folder = await this.folderOf(s);
    const dir = repoDir(this.paths, folder.id);
    const { result, arrived } = await mergeBase(dir, workspace.baseBranch, await this.auth(workspace),
      `Merge origin/${workspace.baseBranch} into ${folder.branch}\n\nPhantom-Session: ${s.id}`);
    if (result === 'merged') {
      const list = this.arrivals.get(s.id) ?? [];
      list.push({ at: Date.now(), commits: arrived ?? [] });
      this.arrivals.set(s.id, list.slice(-20));
      // The merge commit reaches the remote right away, so the remote branch
      // is always complete.
      await pushSession(dir, folder.branch, await this.auth(workspace));
      log.info({ session: s.id, commits: arrived?.length }, 'pulled base');
    } else if (result === 'conflict') {
      if (this.gitFixer) {
        const fixed = await this.gitFixer(s, workspace, dir).catch((e) => {
          log.error({ session: s.id, err: errStr(e) }, 'git fixer threw'); return false;
        });
        // Verify against the REPO, never the Git Fixer's claim.
        if (fixed && await verifyResolved(dir, workspace.baseBranch)) {
          await pushSession(dir, folder.branch, await this.auth(workspace));
          log.info({ session: s.id }, 'conflict resolved by the git fixer and pushed');
          return 'merged';
        }
      }
      // Unresolved: leave nothing half-merged.
      await git(dir, ['merge', '--abort']).catch(() => {});
      log.warn({ session: s.id }, 'pull conflict unresolved — aborted');
    }
    return result;
  }

  /** What moved on base — read-only, changes nothing in the tree. */
  async status(s: SessionRow, workspace: WorkspaceRow): Promise<{
    pending: { commits: string[]; files: string[] };
    sinceClaim: number;
    pulled: Arrival[];
  }> {
    const folder = await this.folderOf(s);
    const dir = repoDir(this.paths, folder.id);
    await git(dir, ['fetch', 'origin', workspace.baseBranch], await this.auth(workspace)).catch(() => {});
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
