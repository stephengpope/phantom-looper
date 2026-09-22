// Disk — two sweeps, both driven from the maintenance loop in index.ts:
//
//   idleBackupSweep — the AUTOMATIC BACKUP: an idle session's work is pushed
//   to its branch on origin (engine.backup: commit + push, never a rebase or
//   a landing). After it, nothing exists only on this disk, and reopening a
//   deleted session re-clones the branch with its work in it.
//
//   pressureSweep — DISK CLEANUP. The disk space rules:
//
//     too full = over disk_cleanup_percent used (0 turns this part off)
//                OR under MIN_FREE_GB free.
//
//   While the disk is too full, sessions are shut down and their files
//   deleted, oldest lastUsedAt first, until it is not. The disk space rules
//   OVERRIDE the container idle timeout (container_idle_ms): a full disk
//   takes a session before its timeout is up. Each session is backed up
//   first, and its container and files are deleted under the same session
//   lock as the backup — no turn can start in between. After each delete,
//   release images older than the running one that no container uses any
//   more are deleted too (a container pins its image).
//
//   A session is SKIPPED, never forced, when it is busy (a turn holds a lock
//   on its folder, or a background task runs there) or its backup fails
//   (retried after RETRY_FAILED_MS). So the disk can only stay full when
//   what is left is busy, cannot be backed up, or one session alone fills
//   it — and the final log names those sessions.
//
//   Never touched: a spare clone (the pool refills it — nothing is freed)
//   and an image newer than the running release (an update in flight pulled
//   it; deleting it made the update fail with "image not on this machine").
import fs from 'node:fs/promises';
import type { SessionRow, WorkspaceRow } from './db/schema.js';
import { API_IMAGE, APP_VERSION } from './env.js';
import type { Settings } from './settings.js';
import type { Workspaces } from './workspaces.js';
import type { Sessions } from './sessions.js';
import type { Paths } from './pool/paths.js';
import type { ContainerManager } from './workspace/container.js';
import type { Images } from './images.js';
import type { GitEngine } from './git/engine.js';
import type { PushResult } from './git/git.js';
import { logger, errStr } from './log.js';

const log = logger('disk');

/** Idle-backup gates: worth it only once a session has real work (turns), and
 *  only after a short quiet spell so the common case is one backup per work
 *  session, not one per coffee sip — with the lock itself as the final check
 *  when the clock lies (one 2-hour command inside a single tool call updates
 *  nothing until it ends, but the running turn HOLDS the lock, so the backup
 *  reads busy). 5 minutes keeps unpushed work on quiet sessions minutes
 *  stale, not hours. */
const BACKUP_MIN_TURNS = 10;
const BACKUP_IDLE_MS = 5 * 60_000;

/** The free-space floor: under this, the disk is too full whatever the
 *  percent setting says. */
export const MIN_FREE_GB = 30;

/** A session whose backup (or delete) failed is left alone this long before
 *  disk cleanup tries it again — a broken checkout fails the same way every
 *  time, and retrying it every minute only fills the log. */
const RETRY_FAILED_MS = 60 * 60_000;

export interface DiskState { usedPct: number; freeGB: number }

/** THE disk space rule — the one check for starting, stopping and the final
 *  log. `pct` <= 0 turns the percent part off; the floor always applies. */
export function tooFull(d: DiskState, pct: number): boolean {
  return (pct > 0 && d.usedPct >= pct) || d.freeGB < MIN_FREE_GB;
}

/** The workspace filesystem, read once. The named volume and docker's own
 *  data share the host's one disk in any standard install, so this speaks
 *  for both. `bavail` (what an unprivileged user may still use) is the
 *  honest measure of "full". */
async function measureDisk(root: string): Promise<DiskState> {
  const st = await fs.statfs(root);
  if (st.blocks === 0) return { usedPct: 0, freeGB: Infinity };
  return {
    usedPct: ((st.blocks - st.bavail) / st.blocks) * 100,
    freeGB: (st.bavail * st.bsize) / (1024 ** 3),
  };
}

const rounded = (d: DiskState) => ({ usedPct: Math.round(d.usedPct), freeGB: Math.round(d.freeGB) });

/** The sessions whose files are on disk (only owners hold disk), each with
 *  its workspace row. Fails CLOSED like every sweep: an unreadable list
 *  aborts the run — not knowing what is protected never licenses deletion. */
async function folderOwners(workspaces: Workspaces, sessions: Sessions): Promise<Array<{ s: SessionRow; w: WorkspaceRow }>> {
  const rows = await sessions.listOwnersOnDisk();
  const byId = new Map((await workspaces.list()).map((w) => [w.id, w]));
  return rows
    .flatMap((s) => {
      const w = byId.get(s.workspaceId);
      return w ? [{ s, w }] : [];
    });
}

const backupOf = async (engine: GitEngine, s: SessionRow, w: WorkspaceRow): Promise<PushResult | 'busy'> =>
  engine.backup(s, w).catch((e) => {
    log.warn({ session: s.id, err: errStr(e) }, 'backup failed');
    return 'error';
  });

/** Push every quiet session's work to its branch, so time itself can never
 *  strand work that exists only on this disk. The gate
 *  `lastPushAt < lastUsedAt` means a session with nothing new since its last
 *  push is never touched — the common case costs no lock, no git, no push. */
export async function idleBackupSweep(workspaces: Workspaces, sessions: Sessions, engine: GitEngine): Promise<void> {
  let owners: Array<{ s: SessionRow; w: WorkspaceRow }>;
  try { owners = await folderOwners(workspaces, sessions); } catch (e) {
    log.warn({ err: errStr(e) }, 'skipping idle backup — could not read state');
    return;
  }
  const now = Date.now();
  for (const { s, w } of owners) {
    if (s.turnCount < BACKUP_MIN_TURNS) continue;
    if (now - s.lastUsedAt.getTime() < BACKUP_IDLE_MS) continue;
    if (s.lastPushAt && s.lastPushAt.getTime() >= s.lastUsedAt.getTime()) continue;
    const r = await backupOf(engine, s, w);
    if (r === 'pushed') log.info({ session: s.id }, 'idle session backed up');
  }
}

/** The api's own image at its current tag — handed in by compose (a container
 *  cannot name its own image). The tag rule is the same one settings.ts uses
 *  for the session image default: a release version is its own tag, anything
 *  else tracks latest. A wrong guess here is harmless: an image a container
 *  uses is never removed. */
const API_IMAGE_CURRENT = (() => {
  const repo = API_IMAGE;
  const v = APP_VERSION;
  return `${repo}:${/^v\d+\.\d+\.\d+/.test(v) ? v : 'latest'}`;
})();

/** Everything disk cleanup does to the world, handed in — so the loop below
 *  is the whole of the logic, and a test runs it against fakes. */
export interface CleanupDeps {
  /** disk_cleanup_percent, read per run. */
  pct: number;
  measure: () => Promise<DiskState>;
  /** The sessions with files on disk, with their workspaces. */
  owners: () => Promise<Array<{ s: SessionRow; w: WorkspaceRow }>>;
  /** Of these folder ids, the busy ones: a turn holds a lock there, or a
   *  background task runs there. */
  busy: (folderIds: string[]) => Promise<Set<string>>;
  /** Delete release images older than the running one that no container uses. */
  removeOldImages: () => Promise<void>;
  /** engine.backup: push, then run `whenSafe` under the same lock only if
   *  everything is on origin. */
  backup: (s: SessionRow, w: WorkspaceRow, whenSafe: () => Promise<void>) => Promise<PushResult | 'busy'>;
  /** The container, then the files (which refuses anything not on origin). */
  deleteSession: (s: SessionRow) => Promise<void>;
  /** Session id -> when its backup or delete last failed. Lives across runs. */
  failed: Map<string, number>;
  now: () => number;
}

/** DISK CLEANUP — the loop. See the file header for the rules. */
export async function diskCleanup(d: CleanupDeps): Promise<void> {
  const start = await d.measure();
  if (!tooFull(start, d.pct)) return;
  log.warn({ ...rounded(start), limitPct: d.pct, minFreeGB: MIN_FREE_GB }, 'disk too full — cleanup started');

  let owners: Array<{ s: SessionRow; w: WorkspaceRow }>;
  let busy: Set<string>;
  try {
    owners = await d.owners();
    busy = await d.busy(owners.map(({ s }) => s.id));
  } catch (e) {
    log.warn({ err: errStr(e) }, 'disk cleanup stopped — could not read sessions');
    return;
  }
  owners.sort((a, b) => a.s.lastUsedAt.getTime() - b.s.lastUsedAt.getTime());

  const left = { busy: [] as string[], failed: [] as string[] };
  for (const { s, w } of owners) {
    await d.removeOldImages();
    if (!tooFull(await d.measure(), d.pct)) break;

    if (busy.has(s.id)) { left.busy.push(s.id); continue; }
    const failedAt = d.failed.get(s.id);
    if (failedAt !== undefined && d.now() - failedAt < RETRY_FAILED_MS) { left.failed.push(s.id); continue; }

    let deleted = false;
    const r = await d.backup(s, w, async () => {
      try {
        await d.deleteSession(s);
        deleted = true;
      } catch (e) {
        log.warn({ session: s.id, err: errStr(e) }, 'disk cleanup: backed up but could not delete');
      }
    }).catch((e) => {
      log.warn({ session: s.id, err: errStr(e) }, 'disk cleanup: backup failed');
      return 'error' as const;
    });

    if (deleted) {
      d.failed.delete(s.id);
      log.info({ session: s.id, result: r }, 'disk cleanup deleted session (work is on its branch)');
    } else if (r === 'busy') {
      left.busy.push(s.id);
    } else {
      d.failed.set(s.id, d.now());
      left.failed.push(s.id);
      log.warn({ session: s.id, result: r }, `disk cleanup skipped session — retrying in ${RETRY_FAILED_MS / 60_000} min`);
    }
  }
  await d.removeOldImages();

  const end = await d.measure();
  if (tooFull(end, d.pct)) {
    log.warn({ ...rounded(end), busy: left.busy, failed: left.failed },
      'disk still too full — what is left is busy or could not be backed up');
  } else {
    log.info(rounded(end), 'disk cleanup done — disk healthy');
  }
}

/** Failures remembered across runs (see RETRY_FAILED_MS). */
const failed = new Map<string, number>();

/** Disk cleanup against the real system. */
export async function pressureSweep(
  settings: Settings, workspaces: Workspaces, sessions: Sessions, p: Paths, images: Images,
  containers: ContainerManager, engine: GitEngine, busy: (folderIds: string[]) => Promise<Set<string>>,
): Promise<void> {
  const currents = [String(await settings.resolve('container_image')), API_IMAGE_CURRENT];
  await diskCleanup({
    pct: Number(await settings.resolve('disk_cleanup_percent')),
    measure: () => measureDisk(p.root),
    owners: () => folderOwners(workspaces, sessions),
    busy,
    // Images owns the rule and refuses while a pull is in flight (images.ts).
    removeOldImages: () => images.removeOlderThan(currents)
      .catch((e) => log.warn({ err: errStr(e) }, 'image cleanup failed')),
    backup: (s, w, whenSafe) => engine.backup(s, w, whenSafe),
    deleteSession: async (s) => {
      await containers.remove(s.id);
      await sessions.destroy(s, { force: false });
    },
    failed,
    now: Date.now,
  });
}
