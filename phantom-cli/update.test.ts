// `phantom-cli update` without a network, a server or a clock: the exact
// lines each situation prints, the wait, the loop guard, and the quit notice
// in both directions. The server is a scripted /health + /update; time is a
// counter the fake sleep advances.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runUpdate, quitNotice, versionLines, elapsed, type UpdateDeps, type Target } from './update.js';

interface Script {
  app?: string;
  latest?: string | null;
  /** /health answers in order; the last repeats. A `null` entry is an unreachable server. */
  health?: ({ version: string; loops_running?: number } | null)[];
  paired?: boolean;
  updateFails?: string;
  installFails?: string;
  yes?: boolean;
  timeoutMs?: number;
}

function harness(s: Script) {
  const out: string[] = [];
  const posted: unknown[] = [];
  const installed: string[] = [];
  const asked: string[] = [];
  let clock = 0;
  let healthCalls = 0;
  const health = s.health ?? [{ version: '0.1.2' }];
  const deps: UpdateDeps = {
    appVersion: s.app ?? '0.1.2',
    latest: async () => s.latest === undefined ? 'v0.1.3' : s.latest,
    server: s.paired === false ? null : {
      url: 'https://box.example.com',
      call: async (method, path, body) => {
        if (method === 'GET' && path === '/health') {
          const h = health[Math.min(healthCalls++, health.length - 1)];
          if (!h) throw new Error('ECONNREFUSED');
          return h;
        }
        if (method === 'POST' && path === '/update') {
          if (s.updateFails) throw new Error(s.updateFails);
          posted.push(body);
          return { tag: (body as { tag: string }).tag, requested: true };
        }
        throw new Error(`unexpected ${method} ${path}`);
      },
    },
    installClient: async (tag) => { if (s.installFails) throw new Error(s.installFails); installed.push(tag); },
    confirm: async (q) => { asked.push(q); return s.yes ?? false; },
    out: (l) => out.push(l),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    pollMs: 3_000,
    timeoutMs: s.timeoutMs ?? 180_000,
  };
  const run = (target: Target = 'both') => runUpdate(target, deps);
  return { run, out, posted, installed, asked };
}

test('update: both behind — client installs, server is posted the latest tag and waited for', async () => {
  const h = harness({ health: [{ version: '0.1.2' }, null, { version: '0.1.2' }, { version: '0.1.3' }] });
  assert.equal(await h.run(), 0);
  assert.deepEqual(h.installed, ['v0.1.3']);
  assert.deepEqual(h.posted, [{ tag: 'v0.1.3' }]);   // the LATEST tag, never the running cli's
  assert.deepEqual(h.out, [
    'Updating to 0.1.3',
    '',
    'This machine: 0.1.2 → 0.1.3',
    '  Installed. It takes effect the next time you open phantom-cli.',
    '',
    'Server: 0.1.2 → 0.1.3',
    '  The server is downloading the update and restarting. Sessions pause for about a minute.',
    '  Waiting... 9s',
    '  Server is on 0.1.3.',
    '',
    'Done. Both are on 0.1.3.',
  ]);
});

test('update: nothing to do is one line', async () => {
  const h = harness({ app: '0.1.3', health: [{ version: '0.1.3' }] });
  assert.equal(await h.run(), 0);
  assert.deepEqual(h.out, ['This machine and the server are both on 0.1.3. Nothing to update.']);
  assert.deepEqual(h.posted, []);
  assert.deepEqual(h.installed, []);
});

test('update: the server never comes back', async () => {
  const h = harness({ app: '0.1.3', health: [{ version: '0.1.2' }, null], timeoutMs: 180_000 });
  assert.equal(await h.run(), 1);
  assert.deepEqual(h.out, [
    'Updating to 0.1.3',
    '',
    'This machine: 0.1.3 is current.',
    '',
    'Server: 0.1.2 → 0.1.3',
    '  The server is downloading the update and restarting. Sessions pause for about a minute.',
    '  Waited 3 minutes and the server still reports 0.1.2. The update did not finish.',
    '  Log in to the server and run: docker logs phantom-update-run',
  ]);
});

test('update: running loops ask first; no is "not updated", yes proceeds', async () => {
  const no = harness({ app: '0.1.3', health: [{ version: '0.1.2', loops_running: 2 }] });
  assert.equal(await no.run('server'), 0);
  assert.deepEqual(no.asked, ['  Continue? [y/N] ']);
  assert.deepEqual(no.posted, []);
  assert.deepEqual(no.out, [
    'Updating to 0.1.3',
    '',
    'Server: 0.1.2 → 0.1.3',
    '  2 cards are being worked on right now. Restarting the server will stop them and mark them blocked.',
    '  Server not updated.',
  ]);

  const yes = harness({ app: '0.1.3', yes: true, health: [{ version: '0.1.2', loops_running: 1 }, { version: '0.1.3' }] });
  assert.equal(await yes.run('server'), 0);
  assert.ok(yes.out.includes('  1 card is being worked on right now. Restarting the server will stop it and mark it blocked.'));
  assert.deepEqual(yes.posted, [{ tag: 'v0.1.3' }]);
  assert.equal(yes.out.at(-1), '  Server is on 0.1.3.');
});

test('update: the server refuses the request — its message, exit 1', async () => {
  const h = harness({ app: '0.1.3', updateFails: 'this server has no updater sidecar (UPDATE_TRIGGER_DIR unset) — re-run install.sh once' });
  assert.equal(await h.run('server'), 1);
  assert.equal(h.out.at(-1), '  The update could not be requested: this server has no updater sidecar (UPDATE_TRIGGER_DIR unset) — re-run install.sh once');
});

test('update --client: only this machine; a failed install is exit 1', async () => {
  const ok = harness({});
  assert.equal(await ok.run('client'), 0);
  assert.deepEqual(ok.out, ['Updating to 0.1.3', '', 'This machine: 0.1.2 → 0.1.3', '  Installed. It takes effect the next time you open phantom-cli.']);
  assert.deepEqual(ok.posted, []);

  const bad = harness({ installFails: 'checksum mismatch for phantom-cli-darwin-arm64.tar.gz — refusing to install it' });
  assert.equal(await bad.run('client'), 1);
  assert.equal(bad.out.at(-1), '  The update failed: checksum mismatch for phantom-cli-darwin-arm64.tar.gz — refusing to install it');
});

test('update: a dev checkout updates with git pull, and the server half still runs', async () => {
  const h = harness({ app: 'dev', health: [{ version: '0.1.2' }, { version: '0.1.3' }] });
  assert.equal(await h.run(), 0);
  assert.equal(h.out[2], 'This machine: a development checkout. Update it with git pull.');
  assert.deepEqual(h.posted, [{ tag: 'v0.1.3' }]);
  assert.equal(h.out.at(-1), '  Server is on 0.1.3.');   // no "Done. Both" from a checkout
});

test('update: unpaired and unreachable servers, and GitHub down', async () => {
  const unpaired = harness({ paired: false });
  assert.equal(await unpaired.run(), 0);
  assert.equal(unpaired.out.at(-1), 'Server: none paired. Open phantom-cli and pair one on /server.');
  assert.equal(await harness({ paired: false }).run('server'), 1);

  const down = harness({ app: '0.1.3', health: [null] });
  assert.equal(await down.run('server'), 1);
  assert.deepEqual(down.out, ['Server: unreachable (https://box.example.com).']);

  const offline = harness({ latest: null });
  assert.equal(await offline.run(), 1);
  assert.deepEqual(offline.out, ['Could not reach GitHub to find the latest release.']);
});

test('quitNotice: both, one side, the other side, server ahead, nothing', () => {
  assert.equal(quitNotice('0.1.2', '0.1.2', 'v0.1.3'),
    'Version 0.1.3 is available. You have 0.1.2 on this machine and on the server.\nRun: phantom-cli update');
  assert.equal(quitNotice('0.1.1', '0.1.2', 'v0.1.3'),
    'Version 0.1.3 is available. You have 0.1.1 on this machine and 0.1.2 on the server.\nRun: phantom-cli update');
  assert.equal(quitNotice('0.1.2', '0.1.3', 'v0.1.3'),
    'Version 0.1.3 is available. This machine is on 0.1.2.\nRun: phantom-cli update --client');
  assert.equal(quitNotice('0.1.3', '0.1.2', 'v0.1.3'),
    'Version 0.1.3 is available. The server is on 0.1.2.\nRun: phantom-cli update --server');
  // GitHub unreachable: the two halves still compare with each other
  assert.equal(quitNotice('0.1.3', '0.1.4', null),
    'The server is on 0.1.4. This machine is on 0.1.3.\nRun: phantom-cli update --client');
  assert.equal(quitNotice('0.1.3', '0.1.3', 'v0.1.3'), null);
  assert.equal(quitNotice('0.1.3', null, null), null);
  // a checkout is never behind; only the server can be named
  assert.equal(quitNotice('dev', '0.1.2', 'v0.1.3'),
    'Version 0.1.3 is available. The server is on 0.1.2.\nRun: phantom-cli update --server');
  assert.equal(quitNotice('dev', '0.1.3', 'v0.1.3'), null);
});

test('versionLines and elapsed', () => {
  assert.deepEqual(versionLines('0.1.3', { url: 'https://box.example.com', version: '0.1.3' }),
    ['This machine: 0.1.3', 'Server:       0.1.3  (https://box.example.com)']);
  assert.deepEqual(versionLines('0.1.3', { url: 'https://box.example.com', version: null }),
    ['This machine: 0.1.3', 'Server:       unreachable  (https://box.example.com)']);
  assert.deepEqual(versionLines('dev', null), ['This machine: dev']);
  assert.equal(elapsed(9_000), '9s');
  assert.equal(elapsed(72_000), '1m 12s');
});
