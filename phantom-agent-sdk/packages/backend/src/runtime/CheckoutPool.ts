// The warm-checkout pool, ported from Shockwave's checkoutPool.ts with the
// target list widened from "whatever Telegram points at" to every project in the
// database, and eviction added (evict and re-stock).
//
// A workspace's LOCATION is its state:
//   pool/setup/<owner>__<name>__<branch>__<ulid>   being cloned — never read
//   pool/ready/<same>                              complete, claimable
//   work/<sessionId>/repo                          claimed; a session owns it
// Movement is always a rename, always forward. A clone that dies halfway is
// stranded in setup/ and can never be mistaken for usable.
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectRow } from '../storage/schema.js';
import type { Projects } from '../storage/Projects.js';

import type { Settings } from '../storage/Settings.js';
import { remoteUrl } from '../git/remote.js';
import { cloneFresh, refreshPristine, type GitAuth } from '../git/Git.js';
import { newId, idTime } from '@phantom-agent-sdk/client';
import { slotPrefix, slotUlid, type Paths } from '../lib/paths.js';
import { logger, errStr } from '../lib/log.js';
import { scopeOf } from '../lib/scopes.js';

const log = logger('pool');

/** A clone still in setup/ after this long is a dead one. Generous — a first
 *  clone of a large project is legitimately slow. Not a setting: it cannot change
 *  an outcome, only how long a corpse lingers. */
const SETUP_STALE_MS = 30 * 60_000;

async function listDir(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir); } catch { return []; }
}
const remove = (target: string) => fs.rm(target, { recursive: true, force: true }).catch(() => {});

/** Credential resolution: project PAT -> global PAT -> unauthenticated. The
 *  specific overrides the general, same chain philosophy as settings. */
// The chain — this project's token, else the global one, else unauthenticated
// — is no longer written out here. It is `github_token` resolved through the
// same layers every other setting uses.
export async function resolveAuth(settings: Settings, project: ProjectRow): Promise<GitAuth> {
  return { url: remoteUrl(project.owner, project.name), pat: await settings.credential('github_token', scopeOf(project)) };
}

/** Claim a ready slot for a project into `dest`. The claim is a RENAME and nothing
 *  else — no locks, no bookkeeping. Two claimants cannot get the same workspace:
 *  one wins, the other gets ENOENT and takes the next or falls through to a
 *  clone at the call site. */
export async function claimSlot(
  paths: Paths, projectId: string, branch: string, dest: string,
): Promise<boolean> {
  const prefix = slotPrefix(projectId, branch);
  for (const slot of await listDir(paths.poolReady)) {
    if (!slot.startsWith(prefix)) continue;
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(path.join(paths.poolReady, slot), dest);
      log.info({ dest, slot }, 'claimed a warm checkout');
      return true;
    } catch {
      // Taken between the listing and the rename — try the next.
    }
  }
  return false;
}

// One tick at a time. A second tick starting under a running one works from a
// stale count and double-stocks.
let ticking = false;

/** Reconcile the pool to what it should be. Everything that is not claiming
 *  happens here; claiming has no side effects, so a session can never be
 *  slowed by maintenance work. */
export async function tick(projects: Projects, settings: Settings, paths: Paths): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    // Stocking fails OPEN: an unreadable project list must not empty the pool —
    // but with no list we cannot distinguish "project removed" from "db down",
    // so we also must not delete anything. Just stop.
    let projectRows: ProjectRow[];
    try { projectRows = await projects.list(); } catch (error) {
      log.warn({ err: errStr(error) }, 'skipping pool tick — could not read projects');
      return;
    }

    const now = Date.now();
    // Abandoned clones: being in setup/ at all means unfinished; age is the only question.
    for (const slot of await listDir(paths.poolSetup)) {
      const stat = await fs.stat(path.join(paths.poolSetup, slot)).catch(() => null);
      if (!stat || now - stat.mtimeMs > SETUP_STALE_MS) await remove(path.join(paths.poolSetup, slot));
    }

    const wanted = new Map(projectRows.map((project) => [slotPrefix(project.id, project.baseBranch), project]));
    const ready = await listDir(paths.poolReady);

    // Slots for projects we no longer serve.
    for (const slot of ready) {
      const prefix = slot.slice(0, slot.lastIndexOf('__') + 2);
      if (!wanted.has(prefix)) await remove(path.join(paths.poolReady, slot));
    }

    // Per-project maintenance, concurrently across projects — one at a time globally
    // would take projects × target ticks to fill from cold.
    await Promise.all([...wanted.entries()].map(async ([prefix, project]) => {
      const cfg = await settings.resolveMany(
        ['spare_clones', 'spare_clone_refresh_ms', 'spare_clone_max_age_ms'],
        scopeOf(project)) as { spare_clones: number; spare_clone_refresh_ms: number; spare_clone_max_age_ms: number };
      const { spare_clones: target, spare_clone_refresh_ms: refreshMs, spare_clone_max_age_ms: maxAgeMs } = cfg;
      const auth = await resolveAuth(settings, project);

      let mine = ready.filter((slot) => slot.startsWith(prefix));

      // Evict past spare_clone_max_age — a re-clone is always correct. Stock
      // time rides in the slot's ULID. A shallow slot goes too: it was stocked
      // before every clone carried the whole commit history (cloneFresh), and
      // a checkout made from it could not find where an older branch left base.
      for (const slot of [...mine]) {
        let stocked = 0;
        try { stocked = idTime(slotUlid(slot)); } catch { /* not a ulid -> evict */ }
        const shallow = await fs.stat(path.join(paths.poolReady, slot, 'repo', '.git', 'shallow')).then(() => true, () => false);
        if (shallow || now - stocked > maxAgeMs) {
          await remove(path.join(paths.poolReady, slot));
          mine = mine.filter((slot) => slot !== slot);
        }
      }

      // Refresh stale slots. Performance only — the claim always fetches, so
      // this can change how much that fetch pulls, never whether it is correct.
      // A slot that will not refresh is discarded, not repaired.
      for (const slot of [...mine]) {
        const full = path.join(paths.poolReady, slot);
        const stat = await fs.stat(full).catch(() => null);
        if (!stat) { mine = mine.filter((slot) => slot !== slot); continue; }
        if (now - stat.mtimeMs < refreshMs) continue;
        try {
          await refreshPristine(path.join(full, 'repo'), auth, project.baseBranch);
          await fs.utimes(full, new Date(), new Date());
        } catch (error) {
          log.warn({ slot, err: errStr(error) }, 'ready checkout would not refresh — discarding');
          await remove(full);
          mine = mine.filter((slot) => slot !== slot);
        }
      }

      // Restock one per project per tick.
      if (mine.length < target) {
        const slot = `${prefix}${newId()}`;
        const staging = path.join(paths.poolSetup, slot);
        try {
          await fs.mkdir(path.join(staging), { recursive: true });
          await cloneFresh(path.join(staging, 'repo'), auth, project.baseBranch);
          await fs.mkdir(path.join(staging, 'scratch'), { recursive: true });
          await fs.mkdir(paths.poolReady, { recursive: true });
          // Only NOW is it usable, and the rename is what says so.
          await fs.rename(staging, path.join(paths.poolReady, slot));
          log.info({ project: `${project.owner}/${project.name}`, have: mine.length + 1, want: target }, 'stocked a warm checkout');
        } catch (error) {
          log.warn({ project: `${project.owner}/${project.name}`, err: errStr(error) }, 'could not stock a warm checkout');
          await remove(staging);
        }
      }
    }));
  } catch (error) {
    log.error({ err: errStr(error) }, 'pool tick failed');
  } finally {
    ticking = false;
  }
}

/** Anything in setup/ predates this process, so by definition its clone died. */
export async function bootCleanup(paths: Paths): Promise<void> {
  await remove(paths.poolSetup);
  await fs.mkdir(paths.poolSetup, { recursive: true });
  await fs.mkdir(paths.poolReady, { recursive: true });
  await fs.mkdir(paths.work, { recursive: true });
}
