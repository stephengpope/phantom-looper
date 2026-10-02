// Disk cleanup against fakes: the rule and the loop, nothing else.
// Run: npx tsx --test phantom-backend/disk.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tooFull, diskCleanup, MIN_FREE_GB, type CleanupDeps, type DiskState } from './disk.js';
import type { SessionRow, ProjectRow } from 'phantom-backend-sdk/schema';

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
  /** Sessions whose work is NOT on base. Default: everything is merged. */
  unmerged?: string[];
}) {
  let free = opts.freeGB;
  const TOTAL = 1000;
  const calls: string[] = [];
  const rows = opts.sessions.map((x) => ({
    s: { id: x.id, lastUsedAt: new Date(NOW - x.ageHours * HOUR) } as SessionRow,
    project: {} as ProjectRow,
    gb: x.gb,
  }));
  let lockHeld = false;
  const deps: CleanupDeps = {
    pct: 80,
    measure: async (): Promise<DiskState> => ({ usedPct: ((TOTAL - free) / TOTAL) * 100, freeGB: free }),
    owners: async () => rows.map(({ s, project }) => ({ s, project })),
    busy: async (ids) => new Set(ids.filter((id) => opts.busy?.includes(id))),
    landed: async (s) => !opts.unmerged?.includes(s.id),
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
  };
  return { deps, calls, deleted: () => calls.filter((c) => c.startsWith('delete:')).map((c) => c.slice(7)) };
}

test('healthy disk: nothing happens', async () => {
  const fake = world({ sessions: [{ id: 'a', ageHours: 100, gb: 10 }], freeGB: 500 });
  await diskCleanup(fake.deps);
  assert.deepEqual(fake.calls, []);
});

test('oldest first, including sessions inside the 3-day timeout, stops once healthy', async () => {
  // 1000 GB disk, 10 GB free: too full. Healthy = under 80% (> 200 GB free).
  const fake = world({
    sessions: [
      { id: 'new', ageHours: 1, gb: 300 },
      { id: 'oldest', ageHours: 200, gb: 100 },
      { id: 'mid', ageHours: 10, gb: 100 },   // well inside 3 days
    ],
    freeGB: 10,
  });
  await diskCleanup(fake.deps);
  // 10 -> 110 free (oldest) -> 210 free (mid) = 79% used: healthy, 'new' kept.
  assert.deepEqual(fake.deleted(), ['oldest', 'mid']);
});

test('busy sessions are skipped, never backed up or deleted', async () => {
  const fake = world({
    sessions: [{ id: 'busy', ageHours: 100, gb: 500 }, { id: 'idle', ageHours: 50, gb: 500 }],
    freeGB: 10,
    busy: ['busy'],
  });
  await diskCleanup(fake.deps);
  assert.ok(!fake.calls.includes('backup:busy'));
  assert.deepEqual(fake.deleted(), ['idle']);
});

test('unmerged sessions are never deleted, whatever the disk says', async () => {
  const fake = world({
    sessions: [
      { id: 'oldest-unmerged', ageHours: 200, gb: 100 },
      { id: 'merged', ageHours: 10, gb: 300 },
    ],
    freeGB: 10,
    unmerged: ['oldest-unmerged'],
  });
  await diskCleanup(fake.deps);
  assert.deepEqual(fake.deleted(), ['merged']);
  assert.ok(!fake.calls.includes('backup:oldest-unmerged'), 'not even backed up by the sweep');
});

test('failed backup: skipped, never deleted, tried again next run', async () => {
  const run = async () => {
    const fake = world({
      sessions: [{ id: 'broken', ageHours: 100, gb: 500 }, { id: 'ok', ageHours: 50, gb: 1 }],
      freeGB: 10,
      backupFails: ['broken'],
    });
    await diskCleanup(fake.deps);
    return fake;
  };
  const first = await run();
  assert.deepEqual(first.deleted(), ['ok']);
  const next = await run();
  assert.ok(next.calls.includes('backup:broken'), 'tried again on the next run');
  assert.ok(!next.deleted().includes('broken'));
});

test('old images are removed before each check and once at the end', async () => {
  const fake = world({ sessions: [{ id: 'a', ageHours: 5, gb: 500 }], freeGB: 10 });
  await diskCleanup(fake.deps);
  assert.deepEqual(fake.calls, ['images', 'backup:a', 'delete:a', 'images']);
});

test('percent 0: a 90%-full disk above the floor deletes nothing (no delete-everything bug)', async () => {
  const fake = world({ sessions: [{ id: 'a', ageHours: 500, gb: 1 }], freeGB: 100 });
  fake.deps.pct = 0;
  await diskCleanup(fake.deps);
  assert.deepEqual(fake.deleted(), []);
});
