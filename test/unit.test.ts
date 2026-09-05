// Pure + real-git tests. No database, no docker — a bare `npm test` must be
// able to run these anywhere git is installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { remoteUrl, hasEmbeddedCredentials, parseGitHubUrl, parseRepoRef } from '../phantom-backend/git/remote.js';
import { encrypt, decrypt } from '../phantom-backend/crypto.js';
import { newId, idTime } from '../core/ids.js';
import { cloneFresh, git, localState, workState, classifyGitFailure } from '../phantom-backend/git/git.js';
import { makePaths, slotPrefix, slotUlid } from '../phantom-backend/pool/paths.js';
import { claimSlot } from '../phantom-backend/pool/pool.js';
import { composeFacts } from '../phantom-backend/environment.js';
import { buildContainerSpec } from '../phantom-backend/workspace/container.js';

// ---- pure -------------------------------------------------------------------

test('remote URLs never carry credentials — the pinned property', () => {
  for (const [o, n] of [['a', 'b'], ['org-x', 'workspace.js'], ['u', 'r']]) {
    assert.equal(hasEmbeddedCredentials(remoteUrl(o, n)), false);
  }
  assert.equal(hasEmbeddedCredentials('https://user:pat@github.com/a/b.git'), true);
  assert.equal(hasEmbeddedCredentials('https://github.com/a/b?x=@y'), false); // '@' in query is legal
});

test('parseGitHubUrl accepts the real shapes and rejects the rest', () => {
  assert.deepEqual(parseGitHubUrl('https://github.com/foo/bar'), { owner: 'foo', name: 'bar' });
  assert.deepEqual(parseGitHubUrl('https://github.com/foo/bar.git'), { owner: 'foo', name: 'bar' });
  assert.throws(() => parseGitHubUrl('https://user:pat@github.com/a/b'));
  assert.throws(() => parseGitHubUrl('git@github.com:a/b.git'));
});

test('parseRepoRef takes what a person types: URL, owner/name, or a bare name', () => {
  assert.deepEqual(parseRepoRef('https://github.com/foo/bar'), { owner: 'foo', name: 'bar' });
  assert.deepEqual(parseRepoRef('foo/bar'), { owner: 'foo', name: 'bar' });
  assert.deepEqual(parseRepoRef('foo/bar.git'), { owner: 'foo', name: 'bar' });
  assert.deepEqual(parseRepoRef(' new-test-project '), { name: 'new-test-project' });
  // URL-shaped input keeps the strict parser's rejections.
  assert.throws(() => parseRepoRef('https://user:pat@github.com/a/b'));
  assert.throws(() => parseRepoRef('git@github.com:a/b.git'));
  assert.throws(() => parseRepoRef('a/b/c'));
  assert.throws(() => parseRepoRef(''));
});

test('classifyGitFailure: git-against-GitHub failures get their meaning, everything else stays untouched', () => {
  const err = (stderr: string) => ({ stderr });
  // The failure this was born from: a dead token cloning a private repo.
  const dead = classifyGitFailure(err(
    "Cloning into '/x/repo'...\nremote: Invalid username or token. Password authentication is not supported for Git operations.\nfatal: Authentication failed for 'https://github.com/a/b.git/'"));
  assert.equal(dead?.code, 'credential_invalid');
  assert.match(dead!.message, /expired or been revoked/);
  assert.match(dead!.message, /\/keys/, 'the message names where the fix is');
  assert.equal(dead?.retryable, false);
  // Same rejection with NO token stored: a different fix, a different sentence.
  const missing = classifyGitFailure(err('fatal: Authentication failed'), { hadToken: false });
  assert.equal(missing?.code, 'credential_invalid');
  assert.match(missing!.message, /no github_token is stored/);
  // A good token that cannot see the repo — GitHub says not-found, on purpose.
  const gone = classifyGitFailure(err('remote: Repository not found.\nfatal: repository not found'));
  assert.equal(gone?.code, 'repo_not_found');
  // Auth wins over not-found when both appear (a 401 is about the token, and
  // GitHub reports not-found for unauthorized reads as cover).
  assert.equal(classifyGitFailure(err('remote: Invalid username or token.\nremote: Repository not found.'))?.code,
    'credential_invalid');
  const offline = classifyGitFailure(err("fatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com"));
  assert.equal(offline?.code, 'upstream_unreachable');
  assert.equal(offline?.retryable, true);
  const scope = classifyGitFailure(err('remote: Write access to repository not granted.\nfatal: unable to access'));
  assert.equal(scope?.code, 'credential_insufficient');
  // Not a remote failure at all: the caller keeps its own error.
  assert.equal(classifyGitFailure(err('fatal: not a git repository')), null);
  assert.equal(classifyGitFailure(new Error('ENOENT: no such file or directory')), null);
});

test('composeFacts: probe lines become the one prompt line; missing tools drop out; no arch = no probe', () => {
  const full = 'os=Debian GNU/Linux 13 (trixie)\narch=arm64\nnode=v24.5.0\npython=Python 3.13.5\n';
  assert.equal(composeFacts(full), 'Debian GNU/Linux 13 (trixie), arm64 · Node v24.5.0 · Python 3.13.5');
  assert.equal(composeFacts('os=Alpine Linux v3.20\narch=x86_64\nnode=\npython=\n'),
    'Alpine Linux v3.20, x86_64', 'an image without node/python says just the OS');
  assert.equal(composeFacts('os=\narch=aarch64\nnode=v24.5.0\npython=\n'),
    'Linux, aarch64 · Node v24.5.0', 'no os-release = plain Linux');
  assert.equal(composeFacts(''), '', 'no output = no line');
  assert.equal(composeFacts('sh: not found'), '', 'garbage = no line');
});

test('buildContainerSpec: docker=false is a plain unprivileged container', () => {
  const base = { name: 'phantom-looper-ws-x', image: 'img', labelValue: 'x', env: [],
    memMb: null, cpus: null, pids: null } as const;
  const spec = buildContainerSpec({ ...base, mount: { bind: '/host/work/x' }, docker: false }) as any;
  assert.equal(spec.HostConfig.Privileged, undefined, 'no docker => not privileged');
  assert.deepEqual(spec.HostConfig.Binds, ['/host/work/x:/workspace']);
  assert.equal(spec.HostConfig.Mounts, undefined, 'no docker + bind => no Mounts at all');
  assert.deepEqual(spec.Cmd, ['sleep', 'infinity'], 'the command is never docker-dependent');
});

test('buildContainerSpec: docker=true adds privileged + an anonymous /var/lib/docker volume', () => {
  const base = { name: 'phantom-looper-ws-x', image: 'img', labelValue: 'x', env: [],
    memMb: null, cpus: null, pids: null } as const;
  // Bind case (dev/tests): workspace via Binds, the graph volume via Mounts.
  const bind = buildContainerSpec({ ...base, mount: { bind: '/host/work/x' }, docker: true }) as any;
  assert.equal(bind.HostConfig.Privileged, true);
  assert.deepEqual(bind.HostConfig.Binds, ['/host/work/x:/workspace']);
  const graph = bind.HostConfig.Mounts.find((m: any) => m.Target === '/var/lib/docker');
  assert.ok(graph, 'a /var/lib/docker mount is present');
  assert.equal(graph.Type, 'volume');
  assert.equal(graph.Source, undefined, 'anonymous (no Source) so it dies with the container');
  assert.deepEqual(bind.Cmd, ['sleep', 'infinity'], 'the daemon is not started — Cmd is unchanged');

  // Volume case (production): both mounts ride Mounts; the graph volume never
  // touches /workspace, so auto-push never commits the agent's docker data.
  const vol = buildContainerSpec({ ...base, mount: { volume: 'phantom-vol', subpath: 'work/x' }, docker: true }) as any;
  const targets = vol.HostConfig.Mounts.map((m: any) => m.Target).sort();
  assert.deepEqual(targets, ['/var/lib/docker', '/workspace']);
  assert.equal(vol.HostConfig.Binds, undefined);
});

test('credential crypto round-trips and rejects tampering', () => {
  const key = Buffer.alloc(32, 7);
  const blob = encrypt(key, 'ghp_secret');
  assert.equal(decrypt(key, blob), 'ghp_secret');
  const bad = Buffer.from(blob); bad[30] ^= 0xff;
  assert.throws(() => decrypt(key, bad));
});

test('ids are lowercase, time-sortable, and carry their mint time', async () => {
  const a = newId();
  await new Promise((r) => setTimeout(r, 3)); // same-ms ULIDs are randomly ordered; time-sortability is the property
  const b = newId();
  assert.match(a, /^[0-9a-z]{26}$/);
  assert.ok(a < b);
  assert.ok(Math.abs(idTime(a) - Date.now()) < 5_000);
});

// ---- real git ---------------------------------------------------------------

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false',
    '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8' });
}

async function makeOrigin(root: string, opts: { daysAgo?: number } = {}): Promise<string> {
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '-q', '--bare', origin]);
  execFileSync('git', ['clone', '-q', origin, seed], { env: { ...process.env, GIT_ALLOW_PROTOCOL: 'file' } });
  sh(seed, ['checkout', '-qb', 'main']); // a clone of an empty origin has an unborn, unnamed branch
  await fs.writeFile(path.join(seed, 'a.txt'), 'hello\n');
  sh(seed, ['add', '-A']);
  const env = opts.daysAgo
    ? { GIT_COMMITTER_DATE: new Date(Date.now() - opts.daysAgo * 86_400_000).toISOString(),
        GIT_AUTHOR_DATE: new Date(Date.now() - opts.daysAgo * 86_400_000).toISOString() }
    : {};
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false',
    'commit', '-qm', 'first'], { cwd: seed, env: { ...process.env, ...env } });
  sh(seed, ['push', '-q', 'origin', 'main']);
  return `file://${origin}`;
}

test('cloneFresh: quiet workspace (no commits in window) still clones at depth 1', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-quiet-'));
  const url = await makeOrigin(root, { daysAgo: 100 });
  const dir = path.join(root, 'clone', 'repo');
  await cloneFresh(dir, { url }, 'main', '7.days'); // deepen fails harmlessly
  const { stdout } = await git(dir, ['rev-list', '--count', 'HEAD']);
  assert.equal(stdout.trim(), '1');
  await fs.rm(root, { recursive: true, force: true });
});

test('after clone + plain fetch, ancestry is intact (rev-list ahead = 0)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-anc-'));
  const url = await makeOrigin(root);
  const dir = path.join(root, 'clone', 'repo');
  await cloneFresh(dir, { url }, 'main', '7.days');
  await git(dir, ['fetch', 'origin', 'main'], { url });
  const { stdout } = await git(dir, ['rev-list', '--count', 'origin/main..HEAD']);
  assert.equal(stdout.trim(), '0', 'non-zero means grafted history — every guard silently inverts');
  await fs.rm(root, { recursive: true, force: true });
});

test('localState: before the first push, only commits that exist nowhere else count', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-state-'));
  const url = await makeOrigin(root);
  const dir = path.join(root, 'clone', 'repo');
  await cloneFresh(dir, { url }, 'main', 'full');
  await git(dir, ['checkout', '-qb', 'agent/x']);
  // No upstream, but nothing exists only here — the branch sits on base.
  assert.equal(await localState(dir, 'agent/x'), 'clean');
  await fs.writeFile(path.join(dir, 'w.txt'), 'w');
  assert.equal(await localState(dir, 'agent/x'), 'dirty');
  // A commit no origin ref holds is real work: no_upstream, never clean.
  await git(dir, ['add', '-A']);
  await git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'w']);
  assert.equal(await localState(dir, 'agent/x'), 'no_upstream');
  await fs.rm(root, { recursive: true, force: true });
});

test('workState: the /resume ladder — not_pushed, not_merged, merged, null', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-work-'));
  const url = await makeOrigin(root);
  const dir = path.join(root, 'clone', 'repo');
  await cloneFresh(dir, { url }, 'main', 'full');
  await git(dir, ['checkout', '-qb', 'agent/w']);
  // A fresh branch holds nothing of its own — everything HEAD has is base.
  assert.equal(await workState(dir, 'agent/w', 'main'), 'merged');
  await fs.writeFile(path.join(dir, 'w.txt'), 'w');
  assert.equal(await workState(dir, 'agent/w', 'main'), 'not_pushed', 'dirty tree');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-qm', 'w']);
  assert.equal(await workState(dir, 'agent/w', 'main'), 'not_pushed', 'committed, branch never pushed');
  await git(dir, ['push', '-q', 'origin', 'HEAD:agent/w'], { url });
  assert.equal(await workState(dir, 'agent/w', 'main'), 'not_merged', 'safe on the branch, not in base');
  await git(dir, ['push', '-q', 'origin', 'HEAD:main'], { url });
  assert.equal(await workState(dir, 'agent/w', 'main'), 'merged', 'auto-push\'s landing');
  // Base moving under other writers cannot un-merge what is in: the local
  // answer needs no fetch to stay true.
  const seed = path.join(root, 'seed');
  sh(seed, ['pull', '-q', 'origin', 'main']);
  await fs.writeFile(path.join(seed, 'b.txt'), 'b');
  sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', 'other']); sh(seed, ['push', '-q', 'origin', 'main']);
  assert.equal(await workState(dir, 'agent/w', 'main'), 'merged', 'others landing on base changes nothing');
  // Pulling base in (archive's auto-push, manual pull) fast-forwards the
  // checkout past origin/agent/w without a branch push. Those commits came
  // from origin: still merged, never "not pushed" (the PHA-29 misread).
  await git(dir, ['fetch', '-q', 'origin', 'main'], { url });
  await git(dir, ['merge', '-q', '--ff-only', 'origin/main']);
  assert.equal(await workState(dir, 'agent/w', 'main'), 'merged', 'caught up with base, branch ref stale');
  // Not knowing is null, never a state.
  const empty = path.join(root, 'empty');
  await fs.mkdir(empty);
  assert.equal(await workState(empty, 'agent/w', 'main'), null);
  await fs.rm(root, { recursive: true, force: true });
});

// ---- pool claim race --------------------------------------------------------

test('one slot, 20 concurrent claimants: exactly one wins', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-claim-'));
  const p = makePaths(root);
  const prefix = slotPrefix('o', 'r', 'main');
  const slot = `${prefix}${newId()}`;
  await fs.mkdir(path.join(p.poolReady, slot, 'repo'), { recursive: true });
  assert.equal(slotUlid(slot).length, 26);
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      claimSlot(p, 'o', 'r', 'main', path.join(p.work, `s${i}`))),
  );
  assert.equal(results.filter(Boolean).length, 1, 'two winners = corrupted concurrency story');
  await fs.rm(root, { recursive: true, force: true });
});

test('a claim never hands out another workspace\'s slot', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-wrong-'));
  const p = makePaths(root);
  await fs.mkdir(path.join(p.poolReady, `${slotPrefix('other', 'repo', 'main')}${newId()}`, 'repo'), { recursive: true });
  assert.equal(await claimSlot(p, 'o', 'r', 'main', path.join(p.work, 's1')), false);
  await fs.rm(root, { recursive: true, force: true });
});

// ---- lifecycle edges --------------------------------------------------------

test('bootCleanup wipes setup/ — a clone that died with the process cannot be claimed', async () => {
  const { bootCleanup } = await import('../phantom-backend/pool/pool.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-boot-'));
  const p = makePaths(root);
  await fs.mkdir(path.join(p.poolSetup, 'o__r__main__deadclone', 'repo'), { recursive: true });
  await bootCleanup(p);
  assert.deepEqual(await fs.readdir(p.poolSetup), []);
  await fs.rm(root, { recursive: true, force: true });
});

test('slot age rides in the ULID: an old slot is recognized as evictable', async () => {
  const { ulid } = await import('ulid');
  const eightDaysAgo = ulid(Date.now() - 8 * 86_400_000).toLowerCase();
  assert.ok(Date.now() - idTime(eightDaysAgo) > 7 * 86_400_000);
  const fresh = newId();
  assert.ok(Date.now() - idTime(fresh) < 60_000);
});

// ---- session titles ---------------------------------------------------------

test('shouldName: turn 1 while unnamed, then every 10th — a fresh duplicate stays quiet', async () => {
  const { shouldName } = await import('../phantom-backend/sessionTitle.js');
  assert.equal(shouldName(null, 1), true);    // first save of a new session
  assert.equal(shouldName(null, 2), false);   // turn-1 generation failed: wait for 10
  assert.equal(shouldName(null, 10), true);
  assert.equal(shouldName('a title', 1), false);  // duplicate: name copied, clock at 0→1
  assert.equal(shouldName('a title', 9), false);
  assert.equal(shouldName('a title', 10), true);
  assert.equal(shouldName('a title', 20), true);
});

test('cleanTitle trims, unwraps quotes, collapses whitespace, caps', async () => {
  const { cleanTitle } = await import('../phantom-backend/sessionTitle.js');
  assert.equal(cleanTitle('  Fix auth token expiry  '), 'Fix auth token expiry');
  assert.equal(cleanTitle('"Kanban board pinning"'), 'Kanban board pinning');
  assert.equal(cleanTitle('“Session title generator”'), 'Session title generator');
  assert.equal(cleanTitle('Fix\n  the   looper'), 'Fix the looper');
  assert.equal(cleanTitle('   '), null);
  assert.equal(cleanTitle(''), null);
  const long = cleanTitle('x'.repeat(200));
  assert.ok(long !== null && long.length <= 81 && long.endsWith('…'));
});

test('recentMessages: last 20 messages, tool traffic clipped, usage lines skipped', async () => {
  const { recentMessages } = await import('../phantom-backend/sessionTitle.js');
  const lines: string[] = [];
  for (let i = 0; i < 30; i++) lines.push(JSON.stringify({ role: 'user', content: `message ${i}` }));
  lines.push(JSON.stringify({ type: 'usage', input: 1, output: 1 }));
  lines.push(JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'working on the parser' }] }));
  const recent = recentMessages(lines.join('\n'));
  assert.ok(!recent.includes('message 9'));           // beyond the 20-message window
  assert.ok(recent.includes('user: message 29'));
  assert.ok(recent.includes('assistant: working on the parser'));
  assert.ok(!recent.includes('"type":"usage"'));      // events are not messages
  // A fat tool result is clipped hard, not carried whole.
  const fat = [
    JSON.stringify({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'read', input: {} }] }),
    JSON.stringify({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'read', output: { type: 'text', value: 'y'.repeat(5000) } }] }),
  ].join('\n');
  const clipped = recentMessages(fat);
  assert.ok(clipped.length < 2000);
  assert.ok(clipped.includes('tool:'));
});

// ---- tasks: ps parsing and grouping ----------------------------------------
// Both userlands the session image family ships: procps (the real workspace image)
// and busybox (the alpine test image). Same invocation, slightly different
// column headers — the parser locates columns by title, never by position.

test('parsePs reads procps- and busybox-shaped output alike', async () => {
  const { parsePs } = await import('../phantom-backend/api/routes/tasks.js');
  const procps = [
    '    PID     SID     ELAPSED COMMAND',
    '      1       1       01:41 /sbin/docker-init -- sleep infinity',
    '      7       1       01:41 sleep infinity',
    '    142     142       00:12 npm run dev',
    '    158     142       00:11 node server.js --port 3000',
  ].join('\n');
  const rows = parsePs(procps);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[2], { pid: '142', sid: '142', elapsed: '00:12', args: 'npm run dev' });
  assert.equal(rows[3].args, 'node server.js --port 3000', 'args keeps its spaces');

  const busybox = [
    'PID   SID  ELAPSED COMMAND',
    '    1    1     1h02 /sbin/docker-init -- sleep infinity',
    '   99   99     0:05 sleep 300',
  ].join('\n');
  const b = parsePs(busybox);
  assert.equal(b.length, 2);
  assert.deepEqual(b[1], { pid: '99', sid: '99', elapsed: '0:05', args: 'sleep 300' });
});

test('parsePs without a SID column falls back to one row per process', async () => {
  const { parsePs } = await import('../phantom-backend/api/routes/tasks.js');
  const out = [
    'PID   ELAPSED COMMAND',
    '  42     0:09 sleep 300',
  ].join('\n');
  const rows = parsePs(out);
  assert.equal(rows[0].sid, '42', 'sid defaults to pid when the column is missing');
});

test('liveGroups drops the baseline and our own ps, groups a tree into one task', async () => {
  const { parsePs, liveGroups } = await import('../phantom-backend/api/routes/tasks.js');
  const out = [
    '    PID     SID     ELAPSED COMMAND',
    '      1       1       01:41 /sbin/docker-init -- sleep infinity',
    '      7       1       01:41 sleep infinity',
    '    142     142       00:12 npm run dev',
    '    158     142       00:11 node server.js',
    '    201     201       00:00 ps -eo pid,sid,etime,args',
    '    301     250       00:30 sleep 302',
  ].join('\n');
  const groups = liveGroups(parsePs(out));
  assert.equal(groups.length, 2, 'baseline (sid 1) and our ps are not tasks');
  const dev = groups.find((g) => g.sid === '142');
  assert.ok(dev);
  assert.equal(dev.command, 'npm run dev', 'the leader names the task');
  assert.equal(dev.pids, 2);
  const stray = groups.find((g) => g.sid === '250');
  assert.ok(stray, 'a leaderless group (its shell exited) still lists');
  assert.equal(stray.command, 'sleep 302');
});

test('elapsedSeconds reads every ps etime shape and refuses the rest', async () => {
  const { elapsedSeconds } = await import('../phantom-backend/api/routes/tasks.js');
  assert.equal(elapsedSeconds('01:41'), 101);
  assert.equal(elapsedSeconds('02:03:04'), 7384);
  assert.equal(elapsedSeconds('1-02:03:04'), 93784);
  assert.equal(elapsedSeconds('  0:05 '), 5);
  assert.equal(elapsedSeconds('garbage'), null);
  assert.equal(elapsedSeconds(''), null);
});
