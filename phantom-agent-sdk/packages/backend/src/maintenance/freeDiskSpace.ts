// free_disk_space — DISK CLEANUP. The disk space rule:
//
//     too full = over disk_cleanup_percent used (0 turns this part off)
//                OR under MIN_FREE_GB free.
//
// While a box's disk is too full, IDLE sessions on it are shut down and
// their files deleted, oldest lastUsedAt first, until it is not. Idle means
// not used for container_idle_ms — the same timeout that stops a container.
// A session used inside it is NEVER deleted, whatever the disk says: the
// disk space rule does not override the timeout. Each session is backed up
// first, and its container and files are deleted under the same session
// lock as the backup — no turn can start in between. Before each delete,
// release images older than the running one that no container uses any
// more are deleted too (a container pins its image): freeing an image
// comes before deleting anyone's checkout.
//
// A session is SKIPPED, never forced, when it was used inside the idle
// timeout, when its work has not landed on base (an unmerged session is
// someone's live work — its files stay, whatever the disk says), when it
// is busy (a turn holds a lock on its workspace), or when its backup
// fails (tried again on the next run). So the disk can only stay full
// when what is left is in use, unmerged, busy, cannot be backed up, or
// one session alone fills it — and the final log names those sessions.
//
// Never touched: a spare clone (the pool refills it — nothing is freed)
// and an image newer than the running release (an update in flight pulled
// it; deleting it made the update fail with "image not on this machine").
import type { SessionRow, ProjectRow } from '../storage/schema.js';
import { API_IMAGE, APP_VERSION } from '../lib/env.js';
import type { Settings } from '../storage/Settings.js';
import type { Projects } from '../storage/Projects.js';
import type { Sessions } from '../storage/Sessions.js';
import type { Runners } from '../host/Runners.js';
import type { SessionContainers } from '../runtime/SessionContainers.js';
import type { WorkspaceHost } from '../runtime/WorkspaceHost.js';
import type { GitSync } from '../git/GitSync.js';
import { workState, type PushResult } from '../git/Git.js';
import type { MaintenanceJob } from './Maintenance.js';
import { workspaceOwners } from './owners.js';
import { logger, errStr } from '../lib/log.js';

const log = logger('disk');

/** The free-space floor: under this, the disk is too full whatever the
 *  percent setting says. Fixed — not a setting. */
export const MIN_FREE_GB = 30;

export interface DiskState { usedPct: number; freeGB: number }

/** THE disk space rule — the one check for starting, stopping and the final
 *  log. `pct` <= 0 turns the percent part off; the floor always applies. */
export function tooFull(disk: DiskState, pct: number): boolean {
  return (pct > 0 && disk.usedPct >= pct) || disk.freeGB < MIN_FREE_GB;
}

const rounded = (disk: DiskState) => ({ usedPct: Math.round(disk.usedPct), freeGB: Math.round(disk.freeGB) });

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
  /** Of these workspace ids, the busy ones: a turn holds a lock there. */
  busy: (workspaceIds: string[]) => Promise<Set<string>>;
  /** Has this session's work landed on base? Unknown counts as no — the
   *  job never deletes on a guess. */
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

/** DISK CLEANUP — the loop, for one box. See the file header for the rules.
 *  Answers how many sessions it deleted. */
export async function diskCleanup(deps: CleanupDeps): Promise<number> {
  const start = await deps.measure();
  if (!tooFull(start, deps.pct)) return 0;
  const box = deps.box ?? 'this server';
  log.warn({ box, ...rounded(start), limitPct: deps.pct, minFreeGB: MIN_FREE_GB }, 'disk too full — cleanup started');

  let owners: Array<{ session: SessionRow; project: ProjectRow }>;
  let busy: Set<string>;
  try {
    owners = await deps.owners();
    busy = await deps.busy(owners.map(({ session }) => session.id));
  } catch (error) {
    log.warn({ box, err: errStr(error) }, 'disk cleanup stopped — could not read sessions');
    return 0;
  }
  owners.sort((a, b) => a.session.lastUsedAt.getTime() - b.session.lastUsedAt.getTime());

  /** Used inside the idle timeout: in use, never deleted. */
  const inUse = (session: SessionRow) => deps.now() - session.lastUsedAt.getTime() < deps.idleMs;

  let deletedCount = 0;
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
      deletedCount++;
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
  return deletedCount;
}

/** Disk cleanup against the real system, one box at a time: this server's
 *  disk, then every online session runner's. A disk is freed only by what
 *  is on it: each box is measured itself, prunes its own old images, and
 *  gives up only the workspaces placed on it. The decisions — which
 *  sessions, idle, busy, landed, backed up — are the API's; the deletion
 *  and the measuring route to the box through its host. This server's box
 *  is measured and pruned whether or not it runs containers: every update
 *  pulls an image here. */
export function freeDiskSpace(deps: {
  settings: Settings; projects: Projects; sessions: Sessions; runners: Runners;
  sessionContainers: SessionContainers; gitSync: GitSync;
  /** Of these workspace ids, the busy ones: a turn holds a lock there. */
  busy: (workspaceIds: string[]) => Promise<Set<string>>;
}): MaintenanceJob {
  const { settings, projects, sessions, runners, sessionContainers, gitSync, busy } = deps;
  return {
    name: 'free_disk_space',
    description: `When a box's disk is over disk_cleanup_percent or under ${MIN_FREE_GB} GB free: frees unused release images, then backs up and deletes idle, merged sessions oldest first until it is not.`,
    where: 'api and session runners',
    async run() {
      const currents = [String(await settings.resolve('container_image')), API_IMAGE_CURRENT];
      const pct = Number(await settings.resolve('disk_cleanup_percent'));
      const idleMs = Number(await settings.resolve('container_idle_ms'));
      // This server's box too, whatever it places: it may still hold workspaces
      // from before runners, and every update pulls an image here.
      const boxes: Array<{ host: WorkspaceHost; hostId: string | null }> = [
        { host: runners.local, hostId: null },
        ...runners.onlineRunners().map((host) => ({ host, hostId: host.id })),
      ];
      let deleted = 0;
      for (const box of boxes) {
        const onBox = async (session: SessionRow) => (await runners.hostIdOf(session.id)) === box.hostId;
        deleted += await diskCleanup({
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
          // Images owns the rule and refuses while a pull is in flight (Images.ts).
          removeOldImages: () => box.host.removeOldImages(currents)
            .catch((error) => log.warn({ box: box.host.name, err: errStr(error) }, 'image cleanup failed')),
          backup: (session, project, whenSafe) => gitSync.backup(session, project, whenSafe),
          deleteSession: async (session) => {
            await sessionContainers.remove(session.id);
            await sessions.destroy(session, { force: false });
          },
        }).catch((error) => { log.warn({ box: box.host.name, err: errStr(error) }, 'disk cleanup failed on this box'); return 0; });
      }
      return { boxes: boxes.length, deleted };
    },
  };
}
