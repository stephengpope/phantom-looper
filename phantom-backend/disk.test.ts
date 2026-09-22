// Disk cleanup against fakes: the rule and the loop, nothing else.
// Run: npx tsx --test phantom-backend/disk.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tooFull, diskCleanup, MIN_FREE_GB, type CleanupDeps, type DiskState } from './disk.js';
import type { SessionRow, WorkspaceRow } from './db/schema.js';

const HOUR = 60 * 60_000;
const NOW = 1_000 * HOUR;

test('tooFull: percent OR free-space floor', () => {
  assert.equal(tooFull({ usedPct: 81, freeGB: 100 }, 80), true);   // over percent
  assert.equal(tooFull({ usedPct: 50, freeGB: MIN_FREE_GB - 1 }, 80), true); // under floor
  assert.equal(tooFull({ usedPct: 79, freeGB: MIN_FREE_GB }, 80), false); // both fine
  assert.equal(tooFull({ usedPct: 99, freeGB: 100 }, 0), false);   // 0 turns percent off
  assert.equal(tooFull({ usedPct: 10, freeGB: 5 }, 0), true);      // ...the floor still applies
});

/** A fake world: each session holds `gb` of disk; deleting it frees that
 *  much. Sessions are listed out of order on purpose. */
function world(opts: {
  sessions: Array<{ id: string; ageHours: number; gb: number }>;
  freeGB: number;
  busy?: string[];
  backupFails?: string[];
  failed?: Map<string, number>;
}) {
  let free = opts.freeGB;
  const TOTAL = 1000;
  const calls: string[] = [];
  const rows = opts.sessions.map((x) => ({
    s: { id: x.id, lastUsedAt: new Date(NOW - x.ageHours * HOUR) } as SessionRow,
    w: {} as WorkspaceRow,
    gb: x.gb,
  }));
  let lockHeld = false;
  const deps: CleanupDeps = {
    pct: 80,
    measure: async (): Promise<DiskState> => ({ usedPct: ((TOTAL - free) / TOTAL) * 100, freeGB: free }),
    owners: async () => rows.map(({ s, w }) => ({ s, w })),
    busy: async (ids) => new Set(ids.filter((id) => opts.busy?.includes(id))),
    removeOldImages: async () => { calls.push('images'); },
    backup: async (s, _w, whenSafe) => {
      calls.push(`backup:${s.id}`);
      if (opts.backupFails?.includes(s.id)) return 'error';
      lockHeld = true;
      try { await whenSafe(); } finally { lockHeld = false; }
      return 'nothing';
    },
    deleteSession: async (s) => {
      assert.equal(lockHeld, true, 'delete must run under the backup lock');
      calls.push(`delete:${s.id}`);
      free += rows.find((r) => r.s.id === s.id)!.gb;
    },
    failed: opts.failed ?? new Map(),
    now: () => NOW,
  };
  return { deps, calls, deleted: () => calls.filter((c) => c.startsWith('delete:')).map((c) => c.slice(7)) };
}

test('healthy disk: nothing happens', async () => {
  const w = world({ sessions: [{ id: 'a', ageHours: 100, gb: 10 }], freeGB: 500 });
  await diskCleanup(w.deps);
  assert.deepEqual(w.calls, []);
});

test('oldest first, including sessions inside the 3-day timeout, stops once healthy', async () => {
  // 1000 GB disk, 10 GB free: too full. Healthy = under 80% (> 200 GB free).
  const w = world({
    sessions: [
      { id: 'new', ageHours: 1, gb: 300 },
      { id: 'oldest', ageHours: 200, gb: 100 },
      { id: 'mid', ageHours: 10, gb: 100 },   // well inside 3 days
    ],
    freeGB: 10,
  });
  await diskCleanup(w.deps);
  // 10 -> 110 free (oldest) -> 210 free (mid) = 79% used: healthy, 'new' kept.
  assert.deepEqual(w.deleted(), ['oldest', 'mid']);
});

test('busy sessions are skipped, never backed up or deleted', async () => {
  const w = world({
    sessions: [{ id: 'busy', ageHours: 100, gb: 500 }, { id: 'idle', ageHours: 50, gb: 500 }],
    freeGB: 10,
    busy: ['busy'],
  });
  await diskCleanup(w.deps);
  assert.ok(!w.calls.includes('backup:busy'));
  assert.deepEqual(w.deleted(), ['idle']);
});

test('failed backup: skipped, remembered, not retried within the hour', async () => {
  const failed = new Map<string, number>();
  const w = world({
    sessions: [{ id: 'broken', ageHours: 100, gb: 500 }, { id: 'ok', ageHours: 50, gb: 1 }],
    freeGB: 10,
    backupFails: ['broken'],
    failed,
  });
  await diskCleanup(w.deps);
  assert.deepEqual(w.deleted(), ['ok']);
  assert.equal(failed.get('broken'), NOW);

  const again = world({
    sessions: [{ id: 'broken', ageHours: 100, gb: 500 }],
    freeGB: 10, backupFails: ['broken'], failed,
  });
  await diskCleanup(again.deps);
  assert.ok(!again.calls.includes('backup:broken'), 'not retried within the hour');

  failed.set('broken', NOW - HOUR - 1);
  const later = world({
    sessions: [{ id: 'broken', ageHours: 100, gb: 500 }],
    freeGB: 10, backupFails: ['broken'], failed,
  });
  await diskCleanup(later.deps);
  assert.ok(later.calls.includes('backup:broken'), 'retried after the hour');
});

test('old images are removed before each check and once at the end', async () => {
  const w = world({ sessions: [{ id: 'a', ageHours: 5, gb: 500 }], freeGB: 10 });
  await diskCleanup(w.deps);
  assert.deepEqual(w.calls, ['images', 'backup:a', 'delete:a', 'images']);
});

test('percent 0: a 90%-full disk above the floor deletes nothing (no delete-everything bug)', async () => {
  const w = world({ sessions: [{ id: 'a', ageHours: 500, gb: 1 }], freeGB: 100 });
  w.deps.pct = 0;
  await diskCleanup(w.deps);
  assert.deepEqual(w.deleted(), []);
});
