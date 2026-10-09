// Disk — two sweeps, both driven from the maintenance loop in index.ts:
//
//   idleBackupSweep — the AUTOMATIC BACKUP: an idle session's work is pushed
//   to its branch on origin (gitSync.backup: commit + push, never a rebase or
//   a landing). After it, nothing exists only on this disk, and reopening a
//   deleted session re-clones the branch with its work in it.
//
//   pressureSweep — DISK CLEANUP. The disk space rules:
//
//     too full = over disk_cleanup_percent used (0 turns this part off)
//                OR under MIN_FREE_GB free.
//
//   While the disk is too full, IDLE sessions are shut down and their files
//   deleted, oldest lastUsedAt first, until it is not. Idle means not used
//   for container_idle_ms — the same timeout that stops a container. A
//   session used inside it is NEVER deleted, whatever the disk says: the
//   disk space rules do not override the timeout. Each session is backed up
//   first, and its container and files are deleted under the same session
//   lock as the backup — no turn can start in between. After each delete,
//   release images older than the running one that no container uses any
//   more are deleted too (a container pins its image).
//
//   A session is SKIPPED, never forced, when it was used inside the idle
//   timeout, when its work has not landed on base (an unmerged session is
//   someone's live work — its files stay, whatever the disk says), when it
//   is busy (a turn holds a lock on its workspace), or when its backup
//   fails (tried again on the next run). So the disk can only stay full
//   when what is left is in use, unmerged, busy, cannot be backed up, or
//   one session alone fills it — and the final log names those sessions.
//
//   Never touched: a spare clone (the pool refills it — nothing is freed)
//   and an image newer than the running release (an update in flight pulled
//   it; deleting it made the update fail with "image not on this machine").
import type { SessionRow, ProjectRow } from '../storage/schema.js';
import { API_IMAGE, APP_VERSION } from '../lib/env.js';
import type { Settings } from '../storage/Settings.js';
import type { Projects } from '../storage/Projects.js';
import type { Sessions } from '../storage/Sessions.js';
import type { SessionRunners } from '../host/SessionRunners.js';
import type { SessionContainers } from './SessionContainers.js';
import type { WorkspaceHost } from './WorkspaceHost.js';
import type { GitSync } from '../git/GitSync.js';
import { workState, type PushResult } from '../git/Git.js';
import { logger, errStr } from '../lib/log.js';

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

export interface DiskState { usedPct: number; freeGB: number }

/** THE disk space rule — the one check for starting, stopping and the final
 *  log. `pct` <= 0 turns the percent part off; the floor always applies. */
export function tooFull(disk: DiskState, pct: number): boolean {
  return (pct > 0 && disk.usedPct >= pct) || disk.freeGB < MIN_FREE_GB;
}

const rounded = (disk: DiskState) => ({ usedPct: Math.round(disk.usedPct), freeGB: Math.round(disk.freeGB) });

/** The sessions whose files are on disk (only owners hold disk), each with
 *  its project row. Fails CLOSED like every sweep: an unreadable list
 *  aborts the run — not knowing what is protected never licenses deletion. */
async function workspaceOwners(projects: Projects, sessions: Sessions): Promise<Array<{ session: SessionRow; project: ProjectRow }>> {
  const rows = await sessions.listOwnersOnDisk();
  const byId = new Map((await projects.list()).map((project) => [project.id, project]));
  return rows
    .flatMap((session) => {
      const project = byId.get(session.projectId);
      return project ? [{ session, project }] : [];
    });
}

const backupOf = async (gitSync: GitSync, session: SessionRow, project: ProjectRow): Promise<PushResult | 'busy'> =>
  gitSync.backup(session, project).catch((error) => {
    log.warn({ session: session.id, err: errStr(error) }, 'backup failed');
    return { error: errStr(error) };
  });

/** Push every quiet session's work to its branch, so time itself can never
 *  strand work that exists only on this disk. The gate
 *  `lastPushAt < lastUsedAt` means a session with nothing new since its last
 *  push is never touched — the common case costs no lock, no git, no push. */
export async function idleBackupSweep(projects: Projects, sessions: Sessions, gitSync: GitSync): Promise<void> {
  let owners: Array<{ session: SessionRow; project: ProjectRow }>;
  try { owners = await workspaceOwners(projects, sessions); } catch (error) {
    log.warn({ err: errStr(error) }, 'skipping idle backup — could not read state');
    return;
  }
  const now = Date.now();
  for (const { session, project } of owners) {
    if (session.turnCount < BACKUP_MIN_TURNS) continue;
    if (now - session.lastUsedAt.getTime() < BACKUP_IDLE_MS) continue;
    if (session.lastPushAt && session.lastPushAt.getTime() >= session.lastUsedAt.getTime()) continue;
    const pushed = await backupOf(gitSync, session, project);
    if (pushed === 'pushed') log.info({ session: session.id }, 'idle session backed up');
  }
}

/** The api's own image at its current tag — handed in by compose (a container
 *  cannot name its own image). The tag rule is the same one settings.ts uses
 *  for the session image default: a release version is its own tag, anything
 *  else tracks latest. A wrong guess here is harmless: an image a container
 *  uses is never removed. */
const API_IMAGE_CURRENT = (() => {
  const repo = API_IMAGE;
  const version = APP_VERSION;
  return `${repo}:${/^v\d+\.\d+\.\d+/.test(version) ? version : 'latest'}`;
})();

/** Everything disk cleanup does to the world, handed in — so the loop below
 *  is the whole of the logic, and a test runs it against fakes. */
export interface CleanupDeps {
  /** The box, for the log lines. */
  box?: string;
  /** disk_cleanup_percent, read per run. */
  pct: number;
  /** container_idle_ms, read per run: a session used inside it is never deleted. */
  idleMs: number;
  now: () => number;
  measure: () => Promise<DiskState>;
  /** The sessions with files on disk, with their projects. */
  owners: () => Promise<Array<{ session: SessionRow; project: ProjectRow }>>;
  /** Of these workspace ids, the busy ones: a turn holds a lock there, or a
   *  background task runs there. */
  busy: (workspaceIds: string[]) => Promise<Set<string>>;
  /** Has this session's work landed on base? Unknown counts as no — the
   *  sweep never deletes on a guess. */
  landed: (session: SessionRow, project: ProjectRow) => Promise<boolean>;
  /** Delete release images older than the running one that no container uses. */
  removeOldImages: () => Promise<void>;
  /** gitSync.backup: push, then run `whenSafe` under the same lock only if
   *  everything is on origin. */
  backup: (session: SessionRow, project: ProjectRow, whenSafe: () => Promise<void>) => Promise<PushResult | 'busy'>;
  /** The session as it is NOW — read again under the lock, before the delete. */
  fresh: (session: SessionRow) => Promise<SessionRow>;
  /** The container, then the files (which refuses anything not on origin). */
  deleteSession: (session: SessionRow) => Promise<void>;
}

/** DISK CLEANUP — the loop. See the file header for the rules. */
export async function diskCleanup(deps: CleanupDeps): Promise<void> {
  const start = await deps.measure();
  if (!tooFull(start, deps.pct)) return;
  const box = deps.box ?? 'this server';
  log.warn({ box, ...rounded(start), limitPct: deps.pct, minFreeGB: MIN_FREE_GB }, 'disk too full — cleanup started');

  let owners: Array<{ session: SessionRow; project: ProjectRow }>;
  let busy: Set<string>;
  try {
    owners = await deps.owners();
    busy = await deps.busy(owners.map(({ session }) => session.id));
  } catch (error) {
    log.warn({ box, err: errStr(error) }, 'disk cleanup stopped — could not read sessions');
    return;
  }
  owners.sort((a, b) => a.session.lastUsedAt.getTime() - b.session.lastUsedAt.getTime());

  /** Used inside the idle timeout: in use, never deleted. */
  const inUse = (session: SessionRow) => deps.now() - session.lastUsedAt.getTime() < deps.idleMs;

  const left = { inUse: [] as string[], unmerged: [] as string[], busy: [] as string[], failed: [] as string[] };
  for (const { session, project } of owners) {
    await deps.removeOldImages();
    if (!tooFull(await deps.measure(), deps.pct)) break;

    if (inUse(session)) { left.inUse.push(session.id); continue; }
    if (busy.has(session.id)) { left.busy.push(session.id); continue; }
    if (!(await deps.landed(session, project))) { left.unmerged.push(session.id); continue; }

    let deleted = false;
    let usedMeanwhile = false;
    const pushed = await deps.backup(session, project, async () => {
      // Under the session lock now. Asked again: a turn that ran between
      // the listing and this lock made the session in use.
      if (inUse(await deps.fresh(session))) { usedMeanwhile = true; return; }
      try {
        await deps.deleteSession(session);
        deleted = true;
      } catch (error) {
        log.warn({ session: session.id, err: errStr(error) }, 'disk cleanup: backed up but could not delete');
      }
    }).catch((error) => {
      log.warn({ session: session.id, err: errStr(error) }, 'disk cleanup: backup failed');
      return { error: errStr(error) };
    });

    if (deleted) {
      log.info({ session: session.id, result: pushed }, 'disk cleanup deleted session (work is on its branch)');
    } else if (usedMeanwhile) {
      left.inUse.push(session.id);
    } else if (pushed === 'busy') {
      left.busy.push(session.id);
    } else {
      left.failed.push(session.id);
      log.warn({ session: session.id, result: pushed }, 'disk cleanup skipped session — not backed up');
    }
  }
  await deps.removeOldImages();

  const end = await deps.measure();
  if (tooFull(end, deps.pct)) {
    log.warn({ box, ...rounded(end), inUse: left.inUse, unmerged: left.unmerged, busy: left.busy, failed: left.failed },
      'disk still too full — what is left is in use, unmerged, busy or could not be backed up');
  } else {
    log.info({ box, ...rounded(end) }, 'disk cleanup done — disk healthy');
  }
}

/** Disk cleanup against the real system, one box at a time: this server's
 *  disk, then every online session runner's. A
 *  disk is freed only by what is on it: each box is measured itself, prunes
 *  its own old images, and gives up only the workspaces placed on it. The
 *  decisions — which sessions, idle, busy, landed, backed up — are the
 *  API's; the deletion and the measuring route to the box through its host.
 *  This server's box is measured and pruned whether or not it runs
 *  containers: every update pulls an image here. */
export async function pressureSweep(
  settings: Settings, projects: Projects, sessions: Sessions, hosts: SessionRunners,
  sessionContainers: SessionContainers, gitSync: GitSync, busy: (workspaceIds: string[]) => Promise<Set<string>>,
): Promise<void> {
  const currents = [String(await settings.resolve('container_image')), API_IMAGE_CURRENT];
  const pct = Number(await settings.resolve('disk_cleanup_percent'));
  const idleMs = Number(await settings.resolve('container_idle_ms'));
  // This server's box too, whatever it places: it may still hold workspaces
  // from before runners, and every update pulls an image here.
  const boxes: Array<{ host: WorkspaceHost; hostId: string | null }> = [
    { host: hosts.local, hostId: null },
    ...hosts.onlineRunners().map((host) => ({ host, hostId: host.id })),
  ];
  for (const box of boxes) {
    const onBox = async (session: SessionRow) => (await hosts.hostIdOf(session.id)) === box.hostId;
    await diskCleanup({
      box: box.host.name,
      pct, idleMs,
      now: () => Date.now(),
      fresh: async (session) => (await sessions.get(session.id)) ?? session,
      measure: () => box.host.disk(),
      owners: async () => {
        const all = await workspaceOwners(projects, sessions);
        const flags = await Promise.all(all.map(({ session }) => onBox(session)));
        return all.filter((_, i) => flags[i]);
      },
      busy,
      // Measured live from the checkout: the stored `work` column is cleared
      // once the container is gone, which is exactly the idle session here.
      landed: async (session, project) => !!session.branch && (await workState(box.host.repo(session.id), session.branch, project.baseBranch)) === 'merged',
      // Images owns the rule and refuses while a pull is in flight (images.ts).
      removeOldImages: () => box.host.removeOldImages(currents)
        .catch((error) => log.warn({ box: box.host.name, err: errStr(error) }, 'image cleanup failed')),
      backup: (session, project, whenSafe) => gitSync.backup(session, project, whenSafe),
      deleteSession: async (session) => {
        await sessionContainers.remove(session.id);
        await sessions.destroy(session, { force: false });
      },
    }).catch((error) => log.warn({ box: box.host.name, err: errStr(error) }, 'disk cleanup failed on this box'));
  }
}
