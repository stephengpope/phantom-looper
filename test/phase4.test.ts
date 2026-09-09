// Phase 4: verification semantics over a real conflicted workspace (no LLM in
// tests — the resolver is a scripted callback), the rebase primitives,
// auto-push end to end on real git, and workspace creation against a fake
// GitHub API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import {
  verifyLanded, rebaseInProgress, rebaseOntoBase, stageAndSquash, commitStaged,
} from '../phantom-backend/git/git.js';
import { autoPush, type AutoPushEvent } from '../phantom-backend/git/autoPush.js';
import { autoPull, type AutoPullEvent } from '../phantom-backend/git/autoPull.js';
import { commitMessageFor } from '../phantom-backend/git/commitMessage.js';
import { testDb, ensureWorkspaceImage, testRoot, setWorkspaceSetting } from './harness.js';
import { makeDb } from '../phantom-backend/db/client.js';
import { migrate } from '../phantom-backend/db/migrate.js';
import { workspaces, sessions } from '../phantom-backend/db/schema.js';
import { encrypt } from '../phantom-backend/crypto.js';
import { newId } from '../core/ids.js';
import { git } from '../phantom-backend/git/git.js';
import { acquireLock, releaseLock } from '../phantom-backend/sessions.js';

const execP = promisify(execFile);

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false',
    '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8' });
}

/** A plain repo on `main` with one commit — the starting point for the rebase
 *  tests, which build their own divergence. */
async function plainRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-p4-'));
  const w = path.join(root, 'w');
  execFileSync('git', ['init', '-q', w]);
  sh(w, ['checkout', '-qb', 'main']);
  await fs.writeFile(path.join(w, 'seed.txt'), 'seed\n');
  sh(w, ['add', '-A']); sh(w, ['commit', '-qm', 'seed']);
  return w;
}

/** A workspace mid-merge with real conflict markers in the named files. */
async function conflictedRepo(files: string[]): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-p4-'));
  const w = path.join(root, 'w');
  execFileSync('git', ['init', '-q', w]);
  sh(w, ['checkout', '-qb', 'main']);
  for (const f of files) await fs.writeFile(path.join(w, f), `base ${f}\n`);
  // a Setext heading: the ======= grep false-positive lives in this file
  await fs.writeFile(path.join(w, 'README.md'), 'Title\n=======\n\ndocs\n');
  sh(w, ['add', '-A']); sh(w, ['commit', '-qm', 'base']);
  sh(w, ['checkout', '-qb', 'other']);
  for (const f of files) await fs.writeFile(path.join(w, f), `other ${f}\n`);
  sh(w, ['add', '-A']); sh(w, ['commit', '-qm', 'other']);
  sh(w, ['checkout', '-q', 'main']);
  for (const f of files) await fs.writeFile(path.join(w, f), `main ${f}\n`);
  sh(w, ['add', '-A']); sh(w, ['commit', '-qm', 'mine']);
  try { sh(w, ['merge', 'other']); } catch { /* conflict expected */ }
  return w;
}

/** Run one shell command in `dir` — how the scripted resolvers below act on the
 *  tree, standing in for the coding agent's container. */
const hostExec = (dir: string) => async (cmd: string) => {
  try {
    const r = await execP('/bin/sh', ['-c', cmd], { cwd: dir });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? String(e), exitCode: err.code ?? 1 };
  }
};

test('verifyLanded: an aborted merge is NOT a resolution', async () => {
  const dir = await conflictedRepo(['x.txt']);
  // The merge in flight is `other` into `main`; give it the remote-tracking ref
  // the engine would have, so verify can ask whether the merge is actually in.
  sh(dir, ['update-ref', 'refs/remotes/origin/other', 'other']);

  sh(dir, ['merge', '--abort']);
  // Clean tree, no unmerged entries, no rebase: every OTHER condition passes...
  assert.equal(await verifyLanded(dir), true);
  // ...and nothing merged, which is the only thing that actually matters.
  assert.equal(await verifyLanded(dir, 'other'), false, 'give-up must not read as resolved');

  try { sh(dir, ['merge', 'other']); } catch { /* conflict expected */ }
  await fs.writeFile(path.join(dir, 'x.txt'), 'resolved\n');
  sh(dir, ['add', '-A']); sh(dir, ['commit', '-qm', 'resolve']);
  assert.equal(await verifyLanded(dir, 'other'), true, 'a real resolution passes');
  await fs.rm(path.dirname(dir), { recursive: true, force: true });
});

test('verifyLanded: a Setext heading is not a conflict — unmerged entries, never a grep for =======', async () => {
  const dir = await conflictedRepo(['a.txt']);
  sh(dir, ['update-ref', 'refs/remotes/origin/other', 'other']);
  await fs.writeFile(path.join(dir, 'a.txt'), 'resolved\n');
  sh(dir, ['add', '-A']); sh(dir, ['commit', '-qm', 'resolve']);
  const readme = await fs.readFile(path.join(dir, 'README.md'), 'utf8');
  assert.match(readme, /=======/, 'the heading is still in the tree');
  assert.equal(await verifyLanded(dir, 'other'), true, 'and it is not mistaken for a conflict');
  await fs.rm(path.dirname(dir), { recursive: true, force: true });
});

test('verifyLanded: a rebase stopped mid-flight fails even though the tree looks clean', async () => {
  const dir = await plainRepo();
  // conflictedRepo([]) leaves no conflict; build a rebase that stops instead.
  await fs.writeFile(path.join(dir, 'c.txt'), 'theirs\n');
  sh(dir, ['add', '-A']); sh(dir, ['commit', '-qm', 'theirs on main']);
  sh(dir, ['checkout', '-qb', 'work', 'HEAD~1']);
  await fs.writeFile(path.join(dir, 'c.txt'), 'ours\n');
  sh(dir, ['add', '-A']); sh(dir, ['commit', '-qm', 'ours on work']);
  sh(dir, ['update-ref', 'refs/remotes/origin/main', 'main']);

  assert.equal(await rebaseOntoBase(dir, 'main'), 'conflict');
  assert.equal(await rebaseInProgress(dir), true);
  // Stage the resolution but DO NOT continue: the tree is clean and there are
  // no unmerged entries, so only the in-progress check can still say no.
  await fs.writeFile(path.join(dir, 'c.txt'), 'both\n');
  sh(dir, ['add', 'c.txt']);
  assert.equal(await verifyLanded(dir, 'main'), false, 'a halted rebase is not a landing');
  sh(dir, ['-c', 'core.editor=true', 'rebase', '--continue']);
  assert.equal(await rebaseInProgress(dir), false);
  assert.equal(await verifyLanded(dir, 'main'), true, 'a finished replay is');
  await fs.rm(path.dirname(dir), { recursive: true, force: true });
});

test('verifyLanded: an aborted REBASE is not a resolution either', async () => {
  const dir = await plainRepo();
  await fs.writeFile(path.join(dir, 'c.txt'), 'theirs\n');
  sh(dir, ['add', '-A']); sh(dir, ['commit', '-qm', 'theirs on main']);
  sh(dir, ['checkout', '-qb', 'work', 'HEAD~1']);
  await fs.writeFile(path.join(dir, 'c.txt'), 'ours\n');
  sh(dir, ['add', '-A']); sh(dir, ['commit', '-qm', 'ours on work']);
  sh(dir, ['update-ref', 'refs/remotes/origin/main', 'main']);

  assert.equal(await rebaseOntoBase(dir, 'main'), 'conflict');
  sh(dir, ['rebase', '--abort']);
  assert.equal(await rebaseInProgress(dir), false, 'nothing in flight after an abort');
  assert.equal(await verifyLanded(dir), true, 'the tree alone says yes — which is the trap');
  assert.equal(await verifyLanded(dir, 'main'), false, 'origin/main not in HEAD is what catches it');
  await fs.rm(path.dirname(dir), { recursive: true, force: true });
});

test('stageAndSquash: many commits plus a dirty tree collapse to ONE commit; nothing to land says so', async () => {
  const dir = await plainRepo();
  sh(dir, ['update-ref', 'refs/remotes/origin/main', 'main']);
  sh(dir, ['checkout', '-qb', 'work']);

  // nothing to land at all
  assert.equal(await stageAndSquash(dir, 'main'), false, 'no work, no commit');
  const headBefore = sh(dir, ['rev-parse', 'HEAD']).trim();

  // three commits and an uncommitted edit
  for (const n of ['1', '2', '3']) {
    await fs.writeFile(path.join(dir, `f${n}.txt`), `${n}\n`);
    sh(dir, ['add', '-A']); sh(dir, ['commit', '-qm', `step ${n}`]);
  }
  await fs.writeFile(path.join(dir, 'f4.txt'), '4\n');
  assert.equal(sh(dir, ['rev-list', '--count', 'origin/main..HEAD']).trim(), '3');

  assert.equal(await stageAndSquash(dir, 'main'), true);
  await commitStaged(dir, 'one commit');
  assert.equal(sh(dir, ['rev-list', '--count', 'origin/main..HEAD']).trim(), '1',
    'ONE commit is what keeps the rebase to a single conflict stop');
  assert.notEqual(sh(dir, ['rev-parse', 'HEAD']).trim(), headBefore);
  for (const n of ['1', '2', '3', '4']) {
    assert.ok(fsSync.existsSync(path.join(dir, `f${n}.txt`)), `f${n} survived the squash`);
  }
  assert.equal(sh(dir, ['status', '--porcelain']).trim(), '', 'the uncommitted edit went in too');
  await fs.rm(path.dirname(dir), { recursive: true, force: true });
});

test('rebaseOntoBase: a clean replay puts base in the history and leaves one commit on top', async () => {
  const dir = await plainRepo();
  await fs.writeFile(path.join(dir, 'theirs.txt'), 'theirs\n');
  sh(dir, ['add', '-A']); sh(dir, ['commit', '-qm', 'theirs on main']);
  sh(dir, ['checkout', '-qb', 'work', 'HEAD~1']);
  await fs.writeFile(path.join(dir, 'ours.txt'), 'ours\n');
  sh(dir, ['add', '-A']); sh(dir, ['commit', '-qm', 'ours on work']);
  sh(dir, ['update-ref', 'refs/remotes/origin/main', 'main']);

  assert.equal(await rebaseOntoBase(dir, 'main'), 'clean');
  assert.equal(await verifyLanded(dir, 'main'), true);
  assert.equal(sh(dir, ['rev-list', '--count', 'origin/main..HEAD']).trim(), '1');
  assert.equal(sh(dir, ['rev-list', '--count', '--merges', 'origin/main..HEAD']).trim(), '0',
    'a rebase landing is a plain commit — no merge commit for a review to skip');
  assert.ok(fsSync.existsSync(path.join(dir, 'theirs.txt')), 'what arrived on base survived');
  assert.ok(fsSync.existsSync(path.join(dir, 'ours.txt')), 'and so did the session work');
  await fs.rm(path.dirname(dir), { recursive: true, force: true });
});

// ── PR creation against a fake GitHub ────────────────────────────────────────

let db: ReturnType<typeof makeDb>['db'];
let pgPool: ReturnType<typeof makeDb>['pool'];
let ghServer: ReturnType<typeof Fastify>;
let ghPort: number;
let createdBare = '';
let lastCreateBody: { name: string; private: boolean; description?: string } | null = null;
const listSeen: { page: number; auth: string; affiliation: string; sort: string }[] = [];

before(async () => {
  ({ db, pool: pgPool } = await testDb('p4'));

  ghServer = Fastify();
  ghServer.get('/user', async () => ({ login: 'acme' }));
  // The listing GitHub pages at 100: 102 rows here, so the second page is
  // real and the third is never asked for. `short` is the one the create
  // test below registers as a workspace.
  ghServer.get('/user/repos', async (req) => {
    const q = req.query as { page?: string; per_page?: string; affiliation?: string; sort?: string };
    listSeen.push({ page: Number(q.page), auth: String(req.headers.authorization), affiliation: q.affiliation ?? '', sort: q.sort ?? '' });
    const per = Number(q.per_page), start = (Number(q.page) - 1) * per, total = 102;
    return Array.from({ length: Math.max(0, Math.min(per, total - start)) }, (_, i) => ({
      name: start + i === 0 ? 'short' : `repo-${start + i}`, owner: { login: 'acme' },
      private: (start + i) % 2 === 0, default_branch: 'main', pushed_at: '2026-08-31T00:00:00Z' }));
  });
  const repos = new Set<string>();
  ghServer.post('/user/repos', async (req, reply) => {
    const body = req.body as { name: string; private: boolean; auto_init: boolean; description?: string };
    lastCreateBody = body;
    if (repos.has(body.name)) return reply.code(422).send({ errors: [{ message: 'name already exists on this account' }] });
    repos.add(body.name);
    // a real empty remote for the initial push to land in
    const bare = path.join(os.tmpdir(), `phantom-created-${body.name}-${Date.now()}.git`);
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    createdBare = bare;
    assert.equal(body.auto_init, false, 'we seed the first commit ourselves');
    return reply.code(201).send({ clone_url: `file://${bare}`, html_url: `https://github.com/acme/${body.name}`, full_name: `acme/${body.name}` });
  });
  await ghServer.listen({ port: 0, host: '127.0.0.1' });
  ghPort = (ghServer.server.address() as { port: number }).port;
  process.env.GITHUB_API_BASE = `http://127.0.0.1:${ghPort}`;
});

after(async () => {
  delete process.env.GITHUB_API_BASE;
  await ghServer?.close();
  await pgPool?.end();
});

test('POST /workspaces create=true: creates on GitHub, seeds base branch, stores the token; exists -> 409', async () => {
  const { buildApp } = await import('../phantom-backend/api/app.js');
  const { makePaths } = await import('../phantom-backend/pool/paths.js');
  const app = await buildApp({ db, paths: makePaths(path.join(os.tmpdir(), 'phantom-p4-ws')), apiKey: 'k',
    encryptionKey: Buffer.alloc(32, 5), version: 'test', pgPool });
  const H = { authorization: 'Bearer k', 'content-type': 'application/json' };

  let r = await app.inject({ method: 'POST', url: '/workspaces', headers: H,
    payload: { url: 'https://github.com/acme/fresh', create: true } });
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(JSON.parse(r.body).error.code, 'credential_required');

  r = await app.inject({ method: 'POST', url: '/workspaces', headers: H,
    payload: { url: 'https://github.com/acme/fresh', create: true, private: true, description: 'a fresh one', token: 'ghp_creator' } });
  assert.equal(r.statusCode, 201, r.body);
  const workspace = JSON.parse(r.body).data;
  assert.equal(workspace.hasCredential, true, 'creation token becomes the workspace credential');
  assert.equal(lastCreateBody?.description, 'a fresh one', 'the description reaches GitHub');
  assert.equal(lastCreateBody?.private, true);
  // the new remote got its first commit on main, from us
  const head = execFileSync('git', ['-C', createdBare, 'log', '--format=%s', 'main'], { encoding: 'utf8' }).trim();
  assert.equal(head, 'Initial commit');
  const tree = execFileSync('git', ['-C', createdBare, 'ls-tree', '--name-only', 'main'], { encoding: 'utf8' });
  assert.match(tree, /README\.md/);

  // create is create — an existing workspace is a failure, not a no-op
  r = await app.inject({ method: 'POST', url: '/workspaces', headers: H,
    payload: { url: 'https://github.com/acme/fresh', create: true, token: 'ghp_creator' } });
  assert.equal(r.statusCode, 409, r.body);
  assert.equal(JSON.parse(r.body).error.code, 'already_exists');

  // A bare name is enough to create: the owner comes from the token's account.
  r = await app.inject({ method: 'POST', url: '/workspaces', headers: H,
    payload: { url: 'solo', create: true, token: 'ghp_creator' } });
  assert.equal(r.statusCode, 201, r.body);
  const solo = JSON.parse(r.body).data;
  assert.equal(solo.owner, 'acme');
  assert.equal(solo.name, 'solo');
  assert.equal(solo.url, 'https://github.com/acme/solo.git');

  // owner/name shorthand registers an existing repo like the URL does.
  r = await app.inject({ method: 'POST', url: '/workspaces', headers: H,
    payload: { url: 'acme/short' } });
  assert.equal(r.statusCode, 201, r.body);
  assert.equal(JSON.parse(r.body).data.url, 'https://github.com/acme/short.git');

  // A bare name WITHOUT create identifies nothing — refused, with the rule.
  r = await app.inject({ method: 'POST', url: '/workspaces', headers: H,
    payload: { url: 'nameless' } });
  assert.equal(r.statusCode, 400, r.body);
  assert.equal(JSON.parse(r.body).error.code, 'invalid_url');
  assert.match(JSON.parse(r.body).error.message, /only works with create/);
  await app.close();
});

test('GET /github/repos: what the stored token sees, paged, marked when already a workspace', async () => {
  const { buildApp } = await import('../phantom-backend/api/app.js');
  const { makePaths } = await import('../phantom-backend/pool/paths.js');
  const app = await buildApp({ db, paths: makePaths(path.join(os.tmpdir(), 'phantom-p4-ws')), apiKey: 'k',
    encryptionKey: Buffer.alloc(32, 5), version: 'test', pgPool });
  const H = { authorization: 'Bearer k', 'content-type': 'application/json' };

  // No token stored: 404, not an empty list — the cli falls back to typing.
  let r = await app.inject({ method: 'GET', url: '/github/repos', headers: H });
  assert.equal(r.statusCode, 404, r.body);
  assert.equal(JSON.parse(r.body).error.code, 'not_set');

  r = await app.inject({ method: 'PATCH', url: '/settings', headers: H, payload: { github_token: 'ghp_reader' } });
  assert.equal(r.statusCode, 200, r.body);
  listSeen.length = 0;
  r = await app.inject({ method: 'GET', url: '/github/repos', headers: H });
  assert.equal(r.statusCode, 200, r.body);
  const rows = JSON.parse(r.body).data as { owner: string; name: string; private: boolean; defaultBranch: string; pushedAt: string; added: boolean }[];
  assert.equal(rows.length, 102, 'both pages, and the short second page ended it');
  assert.deepEqual(listSeen.map((l) => l.page), [1, 2]);
  assert.ok(listSeen.every((l) => l.auth === 'Bearer ghp_reader'), 'the stored token is what GitHub sees');
  assert.equal(listSeen[0].affiliation, 'owner,collaborator,organization_member', 'shared and org repos too');
  assert.equal(listSeen[0].sort, 'pushed');
  assert.deepEqual(rows[0], { owner: 'acme', name: 'short', private: true, defaultBranch: 'main',
    pushedAt: '2026-08-31T00:00:00Z', added: true }, 'acme/short was registered above, so it is marked');
  assert.equal(rows[1].added, false);
  assert.equal(rows[1].name, 'repo-1');
  await app.close();
});

// The whole loop on real git: push pushes the session branch, base moves
// under it, pull conflicts, the Git Fixer resolves inside the lock, and the
// resolution is on origin before the lock releases. Also pins the hardened
// verify — the scripted Git Fixer concludes the merge, so origin/main really is an
// ancestor of HEAD.
test('engine + the coding agent: pull conflict is resolved inside the lock and pushed', async () => {
  const { GitEngine } = await import('../phantom-backend/git/engine.js');
  const { makePaths, repoDir } = await import('../phantom-backend/pool/paths.js');
  const { createSession } = await import('../phantom-backend/sessions.js');
  const { eq } = await import('drizzle-orm');

  const root = await testRoot('phantom-p4e-');
  const paths = makePaths(path.join(root, 'ws'));
  const { bootCleanup } = await import('../phantom-backend/pool/pool.js');
  await bootCleanup(paths);
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['clone', '-q', bare, seed]);
  sh(seed, ['checkout', '-qb', 'main']);
  await fs.writeFile(path.join(seed, 'f.txt'), 'base\n');
  sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', 'base']); sh(seed, ['push', '-q', 'origin', 'main']);

  const key = Buffer.alloc(32, 2);
  const workspaceId = newId();
  await db.insert(workspaces).values({
    id: workspaceId, url: `file://${bare}`, owner: 'local', name: 'e2e',
    baseBranch: 'main', branchPrefix: 'agent', schemaName: `repo_${workspaceId}`,
  });
  const session = await createSession(db, paths, key, workspaceId);
  const dir = repoDir(paths, session.id);

  // session edits f.txt and pushes; base edits f.txt differently
  await fs.writeFile(path.join(dir, 'f.txt'), 'session\n');
  const engine = new GitEngine(db, paths, key, async (_s, _r, d) => {
    // the scripted stand-in for the coding agent's turn: keep both intents and
    // continue the replay. A manual pull runs the same sync as auto-push.
    const exec = hostExec(d);
    await exec('printf "session+base\\n" > f.txt && git add f.txt && git -c core.editor=true -c user.email=f@f -c user.name=agent rebase --continue');
    return true;
  });
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  assert.equal(await engine.push(session, workspace), 'pushed');
  // base moves to a conflicting edit AFTER the session pushed its work
  sh(seed, ['fetch', '-q', 'origin', 'main']); sh(seed, ['reset', '-q', '--hard', 'origin/main']);
  await fs.writeFile(path.join(seed, 'f.txt'), 'base-moved\n');
  sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', 'base move']); sh(seed, ['push', '-q', 'origin', 'main']);

  const result = await engine.pull(session, workspace);
  assert.equal(result, 'merged', 'the resolver inside the lock must convert conflict to merged');
  // resolution reached origin before the lock released
  const remote = execFileSync('git', ['-C', bare, 'show', `refs/heads/${session.branch}:f.txt`], { encoding: 'utf8' });
  assert.equal(remote.trim(), 'session+base');
  await fs.rm(root, { recursive: true, force: true });
});

// ── AUTO-PUSH: the whole path to base, on real git over file:// origins ──────────

/** A workspace + session on its own branch over a fresh bare origin, ready to
 *  auto-push. Returns everything the auto-push tests reach for. */
async function autoPushRoot() {
  const { makePaths, repoDir } = await import('../phantom-backend/pool/paths.js');
  const { createSession } = await import('../phantom-backend/sessions.js');
  const { bootCleanup } = await import('../phantom-backend/pool/pool.js');
  const { eq } = await import('drizzle-orm');
  const root = await testRoot('phantom-p4s-');
  const paths = makePaths(path.join(root, 'ws'));
  await bootCleanup(paths);
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['clone', '-q', bare, seed]);
  sh(seed, ['checkout', '-qb', 'main']);
  await fs.writeFile(path.join(seed, 'f.txt'), 'base\n');
  sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', 'base']); sh(seed, ['push', '-q', 'origin', 'main']);
  const key = Buffer.alloc(32, 2);
  const workspaceId = newId();
  await db.insert(workspaces).values({
    id: workspaceId, url: `file://${bare}`, owner: 'local', name: `pusher-${workspaceId}`,
    baseBranch: 'main', branchPrefix: 'agent', schemaName: `repo_${workspaceId}`,
  });
  const session = await createSession(db, paths, key, workspaceId);
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  const originSha = (ref: string) =>
    execFileSync('git', ['-C', bare, 'rev-parse', ref], { encoding: 'utf8' }).trim();
  const pushMain = (file: string, content: string, msg: string) => {
    sh(seed, ['fetch', '-q', 'origin', 'main']);
    sh(seed, ['reset', '-q', '--hard', 'origin/main']);
    fsSync.writeFileSync(path.join(seed, file), content);
    sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', msg]); sh(seed, ['push', '-q', 'origin', 'main']);
  };
  return { root, paths, key, bare, seed, session, workspace,
    dir: repoDir(paths, session.id), originSha, pushMain,
    deps: (extra: Partial<Parameters<typeof autoPush>[0]> = {}) => ({
      db, paths, encryptionKey: key, ...extra }),
    done: () => fs.rm(root, { recursive: true, force: true }) };
}

test('auto-push: clean — commits, merges a moved base, pushes branch then base, fast-forward', async () => {
  const t = await autoPushRoot();
  // the session edits a file it owns; base moves elsewhere (no conflict)
  await fs.writeFile(path.join(t.dir, 'work.txt'), 'session work\n');
  t.pushMain('other.txt', 'someone else\n', 'other work');
  const events: AutoPushEvent[] = [];
  const r = await autoPush(t.deps({ onEvent: (e) => { events.push(e); } }), t.session, t.workspace);
  assert.equal(r.result, 'pushed', JSON.stringify(r));
  assert.equal(r.rounds, 1);
  // base holds the session's work AND the outside commit — a fast-forward of
  // the merged branch, nothing rewritten, nothing forced
  assert.equal(t.originSha('refs/heads/main'), r.sha, 'main is exactly the pushed HEAD');
  const tree = execFileSync('git', ['-C', t.bare, 'ls-tree', '--name-only', 'main'], { encoding: 'utf8' });
  assert.match(tree, /work\.txt/); assert.match(tree, /other\.txt/);
  // the branch backup went first
  assert.equal(t.originSha(`refs/heads/${t.session.branch}`), r.sha);
  // the commit message fell back to file names (no model configured) + trailer
  const msg = execFileSync('git', ['-C', t.bare, 'log', '--format=%B', '-2', 'main'], { encoding: 'utf8' });
  assert.match(msg, /Update work\.txt/);
  assert.match(msg, new RegExp(`Phantom-Session: ${t.session.id}`));
  assert.ok(events.some((e) => e.step === 'push_base'));
  await t.done();
});

test('auto-push: a stopped rebase goes to the coding agent, briefed, and the resolution lands on base', async () => {
  const t = await autoPushRoot();
  await fs.writeFile(path.join(t.dir, 'f.txt'), 'session line\n');
  t.pushMain('f.txt', 'base line\n', 'base edits the same file');
  let seen: { files: string[]; arrived: string[] } | undefined;
  const r = await autoPush(t.deps({
    resolve: async (_s, _w, d, ctx) => {
      seen = { files: ctx.files, arrived: ctx.arrived };
      // The agent resolves and CONTINUES the replay — it never commits itself.
      const exec = hostExec(d);
      await exec('printf "both lines\\n" > f.txt && git add f.txt && git -c core.editor=true -c user.email=f@f -c user.name=agent rebase --continue');
      return true;
    },
  }), t.session, t.workspace);
  assert.equal(r.result, 'pushed', JSON.stringify(r));
  const now = execFileSync('git', ['-C', t.bare, 'show', 'main:f.txt'], { encoding: 'utf8' });
  assert.equal(now.trim(), 'both lines');
  assert.deepEqual(seen?.files, ['f.txt'], 'the agent is told which files');
  assert.match(seen?.arrived.join('\n') ?? '', /base edits the same file/,
    'and what landed on base — the briefing a separate fixer never had');
  // The landing is a plain commit, not a merge commit a review would skip.
  const merges = execFileSync('git', ['-C', t.bare, 'rev-list', '--count', '--merges', 'main'],
    { encoding: 'utf8' }).trim();
  assert.equal(merges, '0', 'a rebase landing leaves nothing for review to miss');
  await t.done();
});

test('auto-push: the agent cannot resolve -> blocked, base untouched, branch left as it was', async () => {
  const t = await autoPushRoot();
  await fs.writeFile(path.join(t.dir, 'f.txt'), 'session line\n');
  t.pushMain('f.txt', 'base line\n', 'conflicting base work');
  const mainBefore = t.originSha('refs/heads/main');
  const r = await autoPush(t.deps({ resolve: async () => false }), t.session, t.workspace);
  assert.equal(r.result, 'blocked', JSON.stringify(r));
  assert.equal(t.originSha('refs/heads/main'), mainBefore, 'nothing on base');
  // the rebase was aborted — clean tree, the session commit still in place
  const { stdout: status } = await git(t.dir, ['status', '--porcelain']);
  assert.equal(status.trim(), '', 'no half-merged tree left behind');
  const { stdout: subject } = await git(t.dir, ['log', '--format=%s', '-1']);
  assert.match(subject, /Update f\.txt/, 'the auto-push commit survives for the next try');
  await t.done();
});

test('auto-push: nothing to push says so and pushes nothing', async () => {
  const t = await autoPushRoot();
  const mainBefore = t.originSha('refs/heads/main');
  const r = await autoPush(t.deps(), t.session, t.workspace);
  assert.equal(r.result, 'nothing', JSON.stringify(r));
  assert.equal(t.originSha('refs/heads/main'), mainBefore);
  await t.done();
});

// ── AUTO-PULL: base INTO the branch, on the same real origins ─────────────────

test('auto-pull: dirty tree is committed, a moved base merges in, the branch is pushed, arrivals named', async () => {
  const t = await autoPushRoot();
  await fs.writeFile(path.join(t.dir, 'work.txt'), 'in flight\n');   // uncommitted, as a mid-task agent leaves it
  t.pushMain('other.txt', 'someone else\n', 'other work');
  const mainBefore = t.originSha('refs/heads/main');
  const events: AutoPullEvent[] = [];
  const r = await autoPull({ db, paths: t.paths, encryptionKey: t.key, onEvent: (e) => { events.push(e); } }, t.session, t.workspace);
  assert.equal(r.result, 'merged', JSON.stringify(r));
  assert.deepEqual(events.map((e) => e.step),
    ['lock', 'backup', 'commit', 'rebase', 'verify', 'push_branch'],
    'the same steps auto-push runs, stopping before push_base');
  assert.equal(r.arrived?.length, 1, 'one base commit came in');
  assert.match(r.arrived![0], /other work/);
  assert.deepEqual(r.files, ['other.txt'], 'the files the merge touched');
  assert.equal(r.pushed, true);
  // the tree is clean, holds both sides, and base is an ancestor of HEAD
  const { stdout: status } = await git(t.dir, ['status', '--porcelain']);
  assert.equal(status.trim(), '');
  assert.equal(fsSync.readFileSync(path.join(t.dir, 'other.txt'), 'utf8'), 'someone else\n');
  await git(t.dir, ['merge-base', '--is-ancestor', 'origin/main', 'HEAD']);
  // base untouched — a pull never lands on base; the branch backup is on origin
  assert.equal(t.originSha('refs/heads/main'), mainBefore);
  assert.equal(t.originSha(`refs/heads/${t.session.branch}`), r.sha);
  // the in-flight work was committed with the session trailer
  const msg = execFileSync('git', ['-C', t.dir, 'log', '--format=%B', '-3'], { encoding: 'utf8' });
  assert.match(msg, /Update work\.txt/);
  assert.match(msg, new RegExp(`Phantom-Session: ${t.session.id}`));
  await t.done();
});

test('auto-pull: nothing behind -> clean, and a dirty tree is NOT committed', async () => {
  const t = await autoPushRoot();
  await fs.writeFile(path.join(t.dir, 'work.txt'), 'in flight\n');
  const { stdout: headBefore } = await git(t.dir, ['rev-parse', 'HEAD']);
  const events: AutoPullEvent[] = [];
  const r = await autoPull({ db, paths: t.paths, encryptionKey: t.key, onEvent: (e) => { events.push(e); } }, t.session, t.workspace);
  assert.equal(r.result, 'clean', JSON.stringify(r));
  assert.deepEqual(events.map((e) => e.step), ['lock'],
    'nothing behind stops before anything is written — no backup, no commit');
  const { stdout: headAfter } = await git(t.dir, ['rev-parse', 'HEAD']);
  assert.equal(headAfter, headBefore, 'no commit minted');
  const { stdout: status } = await git(t.dir, ['status', '--porcelain']);
  assert.match(status, /work\.txt/, 'the in-flight edit is still uncommitted');
  await t.done();
});

test('auto-pull: a conflict goes to the coding agent; the resolution is on the branch, base untouched', async () => {
  const t = await autoPushRoot();
  await fs.writeFile(path.join(t.dir, 'f.txt'), 'session line\n');
  t.pushMain('f.txt', 'base line\n', 'base edits the same file');
  const mainBefore = t.originSha('refs/heads/main');
  const r = await autoPull({ db, paths: t.paths, encryptionKey: t.key,
    resolve: async (_s, _w, d) => {
      // The agent resolves and CONTINUES the replay — a pull rebases too.
      const exec = hostExec(d);
      await exec('printf "both lines\\n" > f.txt && git add f.txt && git -c core.editor=true -c user.email=f@f -c user.name=agent rebase --continue');
      return true;
    },
  }, t.session, t.workspace);
  assert.equal(r.result, 'merged', JSON.stringify(r));
  assert.equal(fsSync.readFileSync(path.join(t.dir, 'f.txt'), 'utf8').trim(), 'both lines');
  assert.equal(t.originSha('refs/heads/main'), mainBefore, 'nothing on base');
  const branch = execFileSync('git', ['-C', t.bare, 'show', `refs/heads/${t.session.branch}:f.txt`], { encoding: 'utf8' });
  assert.equal(branch.trim(), 'both lines', 'the resolution is backed up on the branch');
  await t.done();
});

test('auto-pull: the agent cannot resolve -> blocked, rebase aborted, the pre-pull commit survives', async () => {
  const t = await autoPushRoot();
  await fs.writeFile(path.join(t.dir, 'f.txt'), 'session line\n');
  t.pushMain('f.txt', 'base line\n', 'conflicting base work');
  const r = await autoPull({ db, paths: t.paths, encryptionKey: t.key, resolve: async () => false }, t.session, t.workspace);
  assert.equal(r.result, 'blocked', JSON.stringify(r));
  const { stdout: status } = await git(t.dir, ['status', '--porcelain']);
  assert.equal(status.trim(), '', 'no half-merged tree left behind');
  const { stdout: subject } = await git(t.dir, ['log', '--format=%s', '-1']);
  assert.match(subject, /Update f\.txt/, 'the session work is committed and kept');
  assert.equal(fsSync.readFileSync(path.join(t.dir, 'f.txt'), 'utf8'), 'session line\n', 'the session side is untouched');
  await t.done();
});

test('the lock IS the busy test: a hold by anyone else refuses both, and nothing is touched', async () => {
  const t = await autoPushRoot();
  await fs.writeFile(path.join(t.dir, 'work.txt'), 'in flight\n');
  const mainBefore = t.originSha('refs/heads/main');
  const headBefore = (await git(t.dir, ['rev-parse', 'HEAD'])).stdout.trim();

  // someone else is mid-turn on this session
  assert.ok(await acquireLock(db, t.session, 'somebody-else', 60_000, 'a turn'));

  const push = await autoPush(t.deps(), t.session, t.workspace);
  assert.equal(push.result, 'busy', JSON.stringify(push));
  const pull = await autoPull({ db, paths: t.paths, encryptionKey: t.key }, t.session, t.workspace);
  assert.equal(pull.result, 'busy', JSON.stringify(pull));

  // refused means refused: no commit, no rewrite, nothing on base
  assert.equal((await git(t.dir, ['rev-parse', 'HEAD'])).stdout.trim(), headBefore);
  assert.equal(t.originSha('refs/heads/main'), mainBefore);
  assert.match((await git(t.dir, ['status', '--porcelain'])).stdout, /work\.txt/,
    'the work is still uncommitted, exactly as it was');

  // released, the same call goes through and releases the hold again after
  await releaseLock(db, t.session.id, 'somebody-else');
  assert.equal((await autoPush(t.deps(), t.session, t.workspace)).result, 'pushed');
  const { eq } = await import('drizzle-orm');
  const [after] = await db.select().from(sessions).where(eq(sessions.id, t.session.id));
  assert.equal(after.lockedBy, null, 'auto-push releases what it took');
  await t.done();
});

// The wire: the route streams, core's ONE client reads it, and the Telegram
// Assistant's kit answers through it. The coding agent has no git tool.
test('auto-push over the route: 503 unwired; wired -> core\'s client streams the steps in words and the Telegram Assistant pushes through it', async () => {
  const { buildApp } = await import('../phantom-backend/api/app.js');
  const { injectFetch } = await import('../phantom-backend/looper/injectFetch.js');
  const { autoPushSession } = await import('../core/llm/tools/git.js');
  const { GitEngine } = await import('../phantom-backend/git/engine.js');
  const { makeDocker } = await import('../phantom-backend/docker.js');
  const { ContainerManager } = await import('../phantom-backend/workspace/container.js');
  const t = await autoPushRoot();
  const H = { authorization: 'Bearer k', 'content-type': 'application/json', 'x-phantom-looper-session': t.session.id };
  const docker = makeDocker();
  const engine = new GitEngine(db, t.paths, t.key);
  const fsDeps = { docker, containers: new ContainerManager(docker, t.paths), engine };

  // Unwired: a refusal envelope, which the client turns into a thrown message.
  const bare = await buildApp({ db, paths: t.paths, apiKey: 'k', encryptionKey: t.key, version: 'test', pgPool, fs: fsDeps, engine });
  const r = await bare.inject({ method: 'POST', url: '/git/auto-push', headers: H, payload: {} });
  assert.equal(r.statusCode, 503, r.body);
  await assert.rejects(
    autoPushSession({ baseUrl: 'http://x', apiKey: 'k', sessionId: t.session.id, fetch: injectFetch(bare) }),
    /auto-push is not wired/);

  // Wired: the real flow behind the route.
  const app = await buildApp({ db, paths: t.paths, apiKey: 'k', encryptionKey: t.key, version: 'test', pgPool, fs: fsDeps, engine,
    autoPush: (s, w, onEvent) => autoPush({ db, paths: t.paths, encryptionKey: t.key, onEvent }, s, w) });
  const f = injectFetch(app);
  const cfg = { baseUrl: 'http://x', apiKey: 'k', sessionId: t.session.id, fetch: f };

  // Nothing to push -> nothing, decided before anything is written: no backup,
  // no commit, no rebase, no model call for a message.
  let steps: string[] = [];
  let out = await autoPushSession(cfg, (label) => steps.push(label));
  assert.equal(out.result, 'nothing', JSON.stringify(out));
  assert.deepEqual(steps, ['taking the session']);

  // Work on the branch -> pushed; the steps arrived in words, the sha is base's tip.
  await fs.writeFile(path.join(t.dir, 'work.txt'), 'in flight\n');
  steps = [];
  out = await autoPushSession(cfg, (label) => steps.push(label));
  assert.equal(out.result, 'pushed', JSON.stringify(out));
  assert.equal(out.sha, t.originSha('main'));
  assert.deepEqual(steps, ['taking the session', 'backing the branch up', 'committing',
    'replaying the work on the base branch', 'verifying against the repo',
    'pushing the branch', 'pushing to the base branch']);

  // The Telegram Assistant's kit carries git_auto_push and answers over the
  // same wire — bound to the account's active session, or an explicit id.
  const { assistantKit } = await import('../phantom-backend/telegram/assistant.js');
  const kit = await assistantKit({ f, apiKey: 'k' }, {
    settings: {}, workspaceId: () => t.workspace.id, activeSession: () => null,
    onSwitch: async () => ({}), approve: async () => false, onWorkspaceCreated: async () => ({}),
  });
  assert.ok(kit.git_auto_push, 'the Telegram Assistant has git_auto_push');
  const run = kit.git_auto_push!.execute as (a: unknown, o: unknown) => Promise<any>;
  let tg = await run({}, {});
  assert.match(tg.error, /no active session/, 'no pointer, no id -> says so');
  await fs.writeFile(path.join(t.dir, 'work.txt'), 'more\n');
  tg = await run({ id: t.session.id }, {});
  assert.equal(tg.result, 'pushed', JSON.stringify(tg));
  assert.equal(tg.session, t.session.id);
  assert.equal(tg.sha, t.originSha('main'));
  await t.done();
});

test('commit message: a failing model is retried 3 times, then file names', async () => {
  const t = await autoPushRoot();
  await fs.writeFile(path.join(t.dir, 'a.txt'), 'x\n');
  await fs.writeFile(path.join(t.dir, 'b.txt'), 'y\n');
  await git(t.dir, ['add', '-A']);
  let calls = 0;
  const failingFetch: typeof fetch = async () => { calls++; throw new Error('model down'); };
  const msg = await commitMessageFor(t.dir, {
    provider: 'anthropic', model: 'claude-fable-5', apiKey: 'k', fetch: failingFetch,
  });
  assert.equal(calls, 3, 'three tries before giving up on the model');
  assert.match(msg, /Update a\.txt, b\.txt/);
  await t.done();
});
