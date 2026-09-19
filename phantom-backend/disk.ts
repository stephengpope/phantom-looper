// Disk — the ONE cleanup trigger. Two sweeps, both driven from the
// maintenance loop in index.ts:
//
//   idleBackupSweep — an idle session's work is pushed to its branch on
//   origin (engine.backup: commit + push, never a rebase or a landing). This
//   is what makes deletion safe: after it, nothing exists only on this disk,
//   and reopening a deleted session re-clones the branch with its work in it.
//
//   pressureSweep — over disk_cleanup_percent, reclaim: image tags from
//   releases OLDER than the running one, then the files of IDLE folders
//   (past container_idle_ms, the one idle rule), oldest first — each backed
//   up first, and skipped (never forced) when the backup cannot run.
//
//   The sweep is passive: it never touches a running container, a spare
//   clone (the pool refills them — nothing is freed) or an image newer than
//   the running release (an update in flight pulled it; deleting it made the
//   update fail with "image not on this machine").
//
// There is deliberately no time-based deletion: a host with free disk keeps
// every session, and a full one cleans itself. One setting, 0 disables.
import fs from 'node:fs/promises';
import type Docker from 'dockerode';
import type { SessionRow, WorkspaceRow } from './db/schema.js';
import { API_IMAGE, APP_VERSION } from './env.js';
import type { Settings } from './settings.js';
import type { Workspaces } from './workspaces.js';
import type { Sessions } from './sessions.js';
import type { Paths } from './pool/paths.js';
import type { ContainerManager } from './workspace/container.js';
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

/** Percent of the workspace filesystem in use, 0-100. The named volume and
 *  docker's own data share the host's one disk in any standard install, so
 *  this one number speaks for both. `bavail` (what an unprivileged user may
 *  still use) is the honest measure of "full". */
async function diskUsedPercent(root: string): Promise<number> {
  const st = await fs.statfs(root);
  return st.blocks === 0 ? 0 : ((st.blocks - st.bavail) / st.blocks) * 100;
}

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

/** Push every quiet session's work to its branch, so the pressure sweep (and
 *  time itself) can never strand work that exists only on this disk. The gate
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
 *  else tracks latest. A wrong guess here is harmless: Docker refuses to
 *  remove a tag a running container uses, and the refusal is just a log. */
const API_IMAGE_CURRENT = (() => {
  const repo = API_IMAGE;
  const v = APP_VERSION;
  return `${repo}:${/^v\d+\.\d+\.\d+/.test(v) ? v : 'latest'}`;
})();

/** `vX.Y.Z` as a comparable triple; anything else (latest, dev, a digest)
 *  is not a release and never ordered. */
const releaseOf = (tag: string): [number, number, number] | null => {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
const olderRelease = (a: [number, number, number], b: [number, number, number]): boolean =>
  a[0] !== b[0] ? a[0] < b[0] : a[1] !== b[1] ? a[1] < b[1] : a[2] < b[2];

/** `repo:tag` split at the tag colon (a registry port colon sits before the
 *  last slash and is not it). */
const splitRef = (ref: string): { repo: string; tag: string } => {
  const i = ref.lastIndexOf(':');
  return i > ref.lastIndexOf('/') ? { repo: ref.slice(0, i), tag: ref.slice(i + 1) } : { repo: ref, tag: '' };
};

/** Dangling layers, plus the session and api images' tags from releases
 *  OLDER than the one in use — a release pulls a new tag and nothing ever
 *  removed the old ones. Never a newer tag (an update in flight pulled it),
 *  never `latest` or any non-release tag, and nothing when the current tag
 *  is not a release itself (no order to compare by). A tag Docker refuses
 *  (in use) is logged and left. */
async function pruneImages(settings: Settings, docker: Docker): Promise<void> {
  await docker.pruneImages();
  const currents = [String(await settings.resolve('container_image')), API_IMAGE_CURRENT]
    .map(splitRef)
    .flatMap(({ repo, tag }) => { const r = releaseOf(tag); return r ? [{ repo, release: r }] : []; });
  const stale = new Set<string>();
  for (const img of await docker.listImages()) {
    for (const ref of img.RepoTags ?? []) {
      const { repo, tag } = splitRef(ref);
      const release = releaseOf(tag);
      if (!release) continue;
      if (currents.some((c) => c.repo === repo && olderRelease(release, c.release))) stale.add(ref);
    }
  }
  for (const tag of stale) {
    await docker.getImage(tag).remove()
      .then(() => log.info({ image: tag }, 'old image removed'))
      .catch((e) => log.warn({ image: tag, err: errStr(e) }, 'could not remove old image'));
  }
}

/** Over the limit, reclaim until back under it — old images first, then
 *  idle folders oldest-first, the disk re-measured before each folder so
 *  the sweep stops the moment enough is freed. A folder whose backup does
 *  not complete is left exactly as it was; the run ends loud when only live
 *  or unbacked work remains. */
export async function pressureSweep(
  settings: Settings, workspaces: Workspaces, sessions: Sessions, p: Paths, docker: Docker, containers: ContainerManager, engine: GitEngine,
): Promise<void> {
  const pct = Number(await settings.resolve('disk_cleanup_percent'));
  if (pct <= 0) return;
  const used = () => diskUsedPercent(p.root);
  if ((await used()) < pct) return;
  log.warn({ used: Math.round(await used()), limit: pct }, 'disk over limit — pressure cleanup started');

  // 1 — image weight from releases older than the running one.
  await pruneImages(settings, docker)
    .catch((e) => log.warn({ err: errStr(e) }, 'image prune failed'));

  // 2 — idle folders, oldest-used first. Idle is THE idle rule, the one the
  // container reaper runs on (container_idle_ms off the folder's
  // lastUsedAt): a folder inside it is live and is never touched. For each:
  // back the branch up, then the container goes DOWN (nothing left writing
  // to the directory), then the files. Locked or unbacked folders are skipped.
  const idleMs = Number(await settings.resolve('container_idle_ms'));
  let owners: Array<{ s: SessionRow; w: WorkspaceRow }>;
  try { owners = await folderOwners(workspaces, sessions); } catch (e) {
    log.warn({ err: errStr(e) }, 'pressure cleanup stopped — could not read sessions');
    return;
  }
  const cutoff = Date.now() - idleMs;
  owners = owners.filter(({ s }) => s.lastUsedAt.getTime() < cutoff);
  owners.sort((a, b) => a.s.lastUsedAt.getTime() - b.s.lastUsedAt.getTime());
  for (const { s, w } of owners) {
    if ((await used()) < pct) break;
    const r = await backupOf(engine, s, w);
    if (r !== 'pushed' && r !== 'nothing') {
      log.warn({ session: s.id, result: r }, 'pressure cleanup left folder in place — backup did not complete');
      continue;
    }
    try {
      await containers.remove(s.id);
      await sessions.destroy(s, { force: false });
      log.info({ session: s.id }, 'pressure cleanup deleted folder files (work on its branch)');
    } catch (e) {
      log.warn({ session: s.id, err: errStr(e) }, 'pressure cleanup could not delete folder files');
    }
  }

  const after = await used();
  if (after >= pct) {
    log.warn({ used: Math.round(after), limit: pct }, 'disk still over limit — only live or unbacked work remains');
  } else {
    log.info({ used: Math.round(after), limit: pct }, 'pressure cleanup done — disk back under limit');
  }
}
