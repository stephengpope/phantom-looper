// Disk — the ONE cleanup trigger. Two sweeps, both driven from the
// maintenance loop in index.ts:
//
//   idleBackupSweep — an idle session's work is pushed to its branch on
//   origin (engine.backup: commit + push, never a rebase or a landing). This
//   is what makes deletion safe: after it, nothing exists only on this disk,
//   and reopening a deleted session re-clones the branch with its work in it.
//
//   pressureSweep — over disk_cleanup_percent, reclaim in order of least
//   loss: idle containers (stateless by design), spare clones (pure cache),
//   old image tags, then sessions oldest-first — each backed up first, and
//   skipped (never forced) when the backup cannot run.
//
// There is deliberately no time-based deletion: a host with free disk keeps
// every session, and a full one cleans itself. One setting, 0 disables.
import fs from 'node:fs/promises';
import type Docker from 'dockerode';
import { eq } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { sessions, sessionColumns, workspaces, type SessionRow, type WorkspaceRow } from './db/schema.js';
import { resolve } from './settings.js';
import { destroySession } from './sessions.js';
import { drainReady } from './pool/pool.js';
import type { Paths } from './pool/paths.js';
import type { ContainerManager } from './workspace/container.js';
import type { GitEngine } from './git/engine.js';
import type { PushResult } from './git/git.js';
import { logger, errStr } from './log.js';

const log = logger('disk');

/** Idle-backup gates: worth it only once a session has real work (turns), and
 *  only after it has been quiet long enough that taking its lock cannot steal
 *  a live turn — with the lock itself as the final check when the clock lies
 *  (one 2-hour command inside a single tool call updates nothing until it
 *  ends, but the running turn HOLDS the lock, so the backup reads busy). */
const BACKUP_MIN_TURNS = 10;
const BACKUP_IDLE_MS = 3_600_000;

/** Percent of the workspace filesystem in use, 0-100. The named volume and
 *  docker's own data share the host's one disk in any standard install, so
 *  this one number speaks for both. `bavail` (what an unprivileged user may
 *  still use) is the honest measure of "full". */
async function diskUsedPercent(root: string): Promise<number> {
  const st = await fs.statfs(root);
  return st.blocks === 0 ? 0 : ((st.blocks - st.bavail) / st.blocks) * 100;
}

/** Active sessions that own their folder (only owners hold disk), each with
 *  its workspace row. Fails CLOSED like every sweep: an unreadable list
 *  aborts the run — not knowing what is protected never licenses deletion. */
async function folderOwners(db: Db): Promise<Array<{ s: SessionRow; w: WorkspaceRow }>> {
  const rows = await db.select(sessionColumns).from(sessions).where(eq(sessions.status, 'active'));
  const byId = new Map((await db.select().from(workspaces)).map((w) => [w.id, w]));
  return rows
    .filter((s) => s.folderId === s.id)
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
export async function idleBackupSweep(db: Db, engine: GitEngine): Promise<void> {
  let owners: Array<{ s: SessionRow; w: WorkspaceRow }>;
  try { owners = await folderOwners(db); } catch (e) {
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
  const repo = process.env.API_IMAGE ?? 'ghcr.io/stephengpope/phantom-backend-api';
  const v = process.env.APP_VERSION ?? 'dev';
  return `${repo}:${/^v\d+\.\d+\.\d+/.test(v) ? v : 'latest'}`;
})();

/** Dangling layers, plus every tag of the session and api images' repos
 *  except the ones in use — a release pulls a new tag and nothing ever
 *  removed the old ones. A tag Docker refuses (in use) is logged and left. */
async function pruneImages(db: Db, docker: Docker): Promise<void> {
  await docker.pruneImages();
  const currents = [String(await resolve(db, 'container_image')), API_IMAGE_CURRENT];
  const stale = new Set<string>();
  for (const img of await docker.listImages()) {
    for (const tag of img.RepoTags ?? []) {
      for (const current of currents) {
        const i = current.lastIndexOf(':');
        const repo = i > current.lastIndexOf('/') ? current.slice(0, i) : current;
        if (tag !== current && (tag === repo || tag.startsWith(`${repo}:`))) stale.add(tag);
      }
    }
  }
  for (const tag of stale) {
    await docker.getImage(tag).remove()
      .then(() => log.info({ image: tag }, 'old image removed'))
      .catch((e) => log.warn({ image: tag, err: errStr(e) }, 'could not remove old image'));
  }
}

/** Over the limit, reclaim until back under it — least loss first, and the
 *  disk re-measured before each session deletion so the sweep stops the
 *  moment enough is freed. A session whose backup does not complete is left
 *  exactly as it was; the run ends loud when only live work remains. */
export async function pressureSweep(
  db: Db, p: Paths, docker: Docker, containers: ContainerManager, engine: GitEngine,
): Promise<void> {
  const pct = Number(await resolve(db, 'disk_cleanup_percent'));
  if (pct <= 0) return;
  const used = () => diskUsedPercent(p.root);
  if ((await used()) < pct) return;
  log.warn({ used: Math.round(await used()), limit: pct }, 'disk over limit — pressure cleanup started');

  // 1 — idle session containers: stateless, so removal is free and frees the
  // per-session docker graph volume with them (reap(0) = no idle wait).
  await containers.reap(0);

  // 2 — spare clones: pure cache; the pool restocks on the next ticks.
  await drainReady(p);

  // 3 — image weight that serves nothing running.
  await pruneImages(db, docker)
    .catch((e) => log.warn({ err: errStr(e) }, 'image prune failed'));

  // 4 — sessions, oldest-used first: back the branch up, then the container
  // goes DOWN (nothing left writing to the directory), then the files.
  // Locked or unbacked sessions are skipped.
  let owners: Array<{ s: SessionRow; w: WorkspaceRow }>;
  try { owners = await folderOwners(db); } catch (e) {
    log.warn({ err: errStr(e) }, 'pressure cleanup stopped — could not read sessions');
    return;
  }
  owners.sort((a, b) => a.s.lastUsedAt.getTime() - b.s.lastUsedAt.getTime());
  for (const { s, w } of owners) {
    if ((await used()) < pct) break;
    const r = await backupOf(engine, s, w);
    if (r !== 'pushed' && r !== 'nothing') {
      log.warn({ session: s.id, result: r }, 'pressure cleanup left session in place — backup did not complete');
      continue;
    }
    try {
      await containers.remove(s.id);
      await destroySession(db, p, s, { force: false });
      log.info({ session: s.id }, 'pressure cleanup deleted session (work on its branch)');
    } catch (e) {
      log.warn({ session: s.id, err: errStr(e) }, 'pressure cleanup could not delete session');
    }
  }

  const after = await used();
  if (after >= pct) {
    log.warn({ used: Math.round(after), limit: pct }, 'disk still over limit — only live or unbacked work remains');
  } else {
    log.info({ used: Math.round(after), limit: pct }, 'pressure cleanup done — disk back under limit');
  }
}
