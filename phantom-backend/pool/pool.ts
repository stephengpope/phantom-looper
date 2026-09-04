// The warm-checkout pool, ported from Shockwave's checkoutPool.ts with the
// target list widened from "whatever Telegram points at" to every workspace in the
// database, and eviction added (evict and re-stock, never re-deepen).
//
// A folder's LOCATION is its state:
//   pool/setup/<owner>__<name>__<branch>__<ulid>   being cloned — never read
//   pool/ready/<same>                              complete, claimable
//   work/<sessionId>/repo                          claimed; a session owns it
// Movement is always a rename, always forward. A clone that dies halfway is
// stranded in setup/ and can never be mistaken for usable.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../db/client.js';
import { workspaces, type WorkspaceRow } from '../db/schema.js';

import { resolve, resolveCredential } from '../settings.js';
import { cloneFresh, refreshPristine, type GitAuth } from '../git/git.js';
import { newId, idTime } from '../../core/ids.js';
import { slotPrefix, slotUlid, type Paths } from './paths.js';
import { logger, errStr } from '../log.js';

const log = logger('pool');

/** A clone still in setup/ after this long is a dead one. Generous — a first
 *  clone of a large workspace is legitimately slow. Not a setting: it cannot change
 *  an outcome, only how long a corpse lingers. */
const SETUP_STALE_MS = 30 * 60_000;

async function listDir(dir: string): Promise<string[]> {
  try { return await fs.readdir(dir); } catch { return []; }
}
const rm = (p: string) => fs.rm(p, { recursive: true, force: true }).catch(() => {});

/** Credential resolution: workspace PAT -> global PAT -> unauthenticated. The
 *  specific overrides the general, same chain philosophy as settings. */
// The chain — this workspace's token, else the global one, else unauthenticated
// — is no longer written out here. It is `github_token` resolved through the
// same layers every other setting uses.
export async function resolveAuth(db: Db, r: WorkspaceRow, encryptionKey: Buffer): Promise<GitAuth> {
  return { url: r.url, pat: await resolveCredential(db, encryptionKey, 'github_token', { workspace: r }) };
}

/** Claim a ready slot for a workspace into `dest`. The claim is a RENAME and nothing
 *  else — no locks, no bookkeeping. Two claimants cannot get the same folder:
 *  one wins, the other gets ENOENT and takes the next or falls through to a
 *  clone at the call site. */
export async function claimSlot(
  p: Paths, owner: string, name: string, branch: string, dest: string,
): Promise<boolean> {
  const prefix = slotPrefix(owner, name, branch);
  for (const slot of await listDir(p.poolReady)) {
    if (!slot.startsWith(prefix)) continue;
    try {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(path.join(p.poolReady, slot), dest);
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
export async function tick(db: Db, p: Paths, encryptionKey: Buffer): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    // Stocking fails OPEN: an unreadable workspace list must not empty the pool —
    // but with no list we cannot distinguish "workspace removed" from "db down",
    // so we also must not delete anything. Just stop.
    let workspaceRows: WorkspaceRow[];
    try { workspaceRows = await db.select().from(workspaces); } catch (e) {
      log.warn({ err: errStr(e) }, 'skipping pool tick — could not read workspaces');
      return;
    }

    const now = Date.now();
    // Abandoned clones: being in setup/ at all means unfinished; age is the only question.
    for (const slot of await listDir(p.poolSetup)) {
      const st = await fs.stat(path.join(p.poolSetup, slot)).catch(() => null);
      if (!st || now - st.mtimeMs > SETUP_STALE_MS) await rm(path.join(p.poolSetup, slot));
    }

    const wanted = new Map(workspaceRows.map((r) => [slotPrefix(r.owner, r.name, r.baseBranch), r]));
    const ready = await listDir(p.poolReady);

    // Slots for workspaces we no longer serve.
    for (const slot of ready) {
      const prefix = slot.slice(0, slot.lastIndexOf('__') + 2);
      if (!wanted.has(prefix)) await rm(path.join(p.poolReady, slot));
    }

    // Per-workspace maintenance, concurrently across workspaces — one at a time globally
    // would take workspaces × target ticks to fill from cold.
    await Promise.all([...wanted.entries()].map(async ([prefix, workspace]) => {
      const target = await resolve(db, 'spare_clones', { workspace });
      const refreshMs = await resolve(db, 'spare_clone_refresh_ms');
      const maxAgeMs = await resolve(db, 'spare_clone_max_age_ms');
      const depth = await resolve(db, 'initial_history_depth', { workspace });
      const auth = await resolveAuth(db, workspace, encryptionKey);

      let mine = ready.filter((s) => s.startsWith(prefix));

      // Evict past spare_clone_max_age — a re-clone is always correct, and the shallow
      // boundary (cut at stock time, never moved) stays honest without graft
      // arithmetic. Stock time rides in the slot's ULID.
      for (const slot of [...mine]) {
        let stocked = 0;
        try { stocked = idTime(slotUlid(slot)); } catch { /* not a ulid -> evict */ }
        if (now - stocked > maxAgeMs) {
          await rm(path.join(p.poolReady, slot));
          mine = mine.filter((s) => s !== slot);
        }
      }

      // Refresh stale slots. Performance only — the claim always fetches, so
      // this can change how much that fetch pulls, never whether it is correct.
      // A slot that will not refresh is discarded, not repaired.
      for (const slot of [...mine]) {
        const full = path.join(p.poolReady, slot);
        const st = await fs.stat(full).catch(() => null);
        if (!st) { mine = mine.filter((s) => s !== slot); continue; }
        if (now - st.mtimeMs < refreshMs) continue;
        try {
          await refreshPristine(path.join(full, 'repo'), auth, workspace.baseBranch);
          await fs.utimes(full, new Date(), new Date());
        } catch (e) {
          log.warn({ slot, err: errStr(e) }, 'ready checkout would not refresh — discarding');
          await rm(full);
          mine = mine.filter((s) => s !== slot);
        }
      }

      // Restock one per workspace per tick.
      if (mine.length < target) {
        const slot = `${prefix}${newId()}`;
        const staging = path.join(p.poolSetup, slot);
        try {
          await fs.mkdir(path.join(staging), { recursive: true });
          await cloneFresh(path.join(staging, 'repo'), auth, workspace.baseBranch, depth);
          await fs.mkdir(path.join(staging, 'scratch'), { recursive: true });
          await fs.mkdir(p.poolReady, { recursive: true });
          // Only NOW is it usable, and the rename is what says so.
          await fs.rename(staging, path.join(p.poolReady, slot));
          log.info({ workspace: `${workspace.owner}/${workspace.name}`, have: mine.length + 1, want: target }, 'stocked a warm checkout');
        } catch (e) {
          log.warn({ workspace: `${workspace.owner}/${workspace.name}`, err: errStr(e) }, 'could not stock a warm checkout');
          await rm(staging);
        }
      }
    }));
  } catch (e) {
    log.error({ err: errStr(e) }, 'pool tick failed');
  } finally {
    ticking = false;
  }
}

/** Anything in setup/ predates this process, so by definition its clone died. */
export async function bootCleanup(p: Paths): Promise<void> {
  await rm(p.poolSetup);
  await fs.mkdir(p.poolSetup, { recursive: true });
  await fs.mkdir(p.poolReady, { recursive: true });
  await fs.mkdir(p.work, { recursive: true });
}
