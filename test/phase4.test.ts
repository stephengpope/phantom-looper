// Phase 4: the Git Fixer's loop over a real conflicted workspace (scripted
// driver — no LLM in tests), verification semantics, auto-push end to end on real
// git, and workspace creation against a fake GitHub API.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { runGitFixer, verifyResolved, type GitFixerDriver, type GitFixerExec } from '../phantom-backend/git/gitFixer.js';
import { autoPush, type AutoPushEvent } from '../phantom-backend/git/autoPush.js';
import { commitMessageFor } from '../phantom-backend/git/commitMessage.js';
import { testDb, ensureWorkspaceImage, testRoot, setWorkspaceSetting } from './harness.js';
import { makeDb } from '../phantom-backend/db/client.js';
import { migrate } from '../phantom-backend/db/migrate.js';
import { workspaces, sessions } from '../phantom-backend/db/schema.js';
import { encrypt } from '../phantom-backend/crypto.js';
import { newId } from '../core/ids.js';
import { git } from '../phantom-backend/git/git.js';

const execP = promisify(execFile);

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false',
    '-c', 'protocol.file.allow=always', ...args], { cwd, encoding: 'utf8' });
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

const hostExec = (dir: string): GitFixerExec => async (cmd) => {
  try {
    const r = await execP('/bin/sh', ['-c', cmd], { cwd: dir });
    return { stdout: r.stdout, stderr: r.stderr, exitCode: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; code?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? String(e), exitCode: err.code ?? 1 };
  }
};

test('git fixer: resolves across attempts on the same directory; verify is authoritative', async () => {
  const dir = await conflictedRepo(['a.txt', 'b.txt']);
  let calls = 0;
  const driver: GitFixerDriver = {
    available: async () => true,
    async runSession(exec) {
      calls++;
      if (calls === 1) {
        // First attempt resolves only a.txt and commits nothing — the model
        // "thought it was done". Verify must catch it.
        await exec('printf "resolved a\\n" > a.txt && git add a.txt');
      } else {
        await exec('printf "resolved b\\n" > b.txt && git add b.txt && git -c user.email=f@f -c user.name=git-fixer commit -q --no-verify -m "git fixer: resolve"');
      }
    },
  };
  const ok1 = await runGitFixer(dir, hostExec(dir), 'main', driver, { attempts: 3 });
  assert.equal(ok1, true);
  assert.equal(calls, 2, 'attempt 2 must inherit attempt 1 resolutions');
  // Setext heading survived and verify still passes — diff-filter=U, not grep
  const readme = await fs.readFile(path.join(dir, 'README.md'), 'utf8');
  assert.match(readme, /=======/);
  assert.equal(await verifyResolved(dir), true);
  await fs.rm(path.dirname(dir), { recursive: true, force: true });
});

test('git fixer: unavailable driver refuses loudly, resolves nothing', async () => {
  const dir = await conflictedRepo(['x.txt']);
  const driver: GitFixerDriver = { available: async () => false, async runSession() { throw new Error('never'); } };
  assert.equal(await runGitFixer(dir, hostExec(dir), 'main', driver, { attempts: 3 }), false);
  assert.equal(await verifyResolved(dir), false, 'tree must still show the conflict');
  await fs.rm(path.dirname(dir), { recursive: true, force: true });
});

test('git fixer: exhausts attempts on an unresolvable tree and reports failure', async () => {
  const dir = await conflictedRepo(['x.txt']);
  let calls = 0;
  const driver: GitFixerDriver = {
    available: async () => true,
    async runSession() { calls++; /* does nothing useful */ },
  };
  assert.equal(await runGitFixer(dir, hostExec(dir), 'main', driver, { attempts: 2 }), false);
  assert.equal(calls, 2);
  await fs.rm(path.dirname(dir), { recursive: true, force: true });
});

test('verifyResolved: an aborted merge is NOT a resolution', async () => {
  const dir = await conflictedRepo(['x.txt']);
  // The merge in flight is `other` into `main`; give it the remote-tracking ref
  // the engine would have, so verify can ask whether the merge is actually in.
  sh(dir, ['update-ref', 'refs/remotes/origin/other', 'other']);

  sh(dir, ['merge', '--abort']);
  // Clean tree, no unmerged entries: both of the old conditions pass...
  assert.equal(await verifyResolved(dir), true);
  // ...and nothing merged, which is the only thing that actually matters.
  assert.equal(await verifyResolved(dir, 'other'), false, 'give-up must not read as resolved');

  try { sh(dir, ['merge', 'other']); } catch { /* conflict expected */ }
  await fs.writeFile(path.join(dir, 'x.txt'), 'resolved\n');
  sh(dir, ['add', '-A']); sh(dir, ['commit', '-qm', 'resolve']);
  assert.equal(await verifyResolved(dir, 'other'), true, 'a real resolution passes');
  await fs.rm(path.dirname(dir), { recursive: true, force: true });
});

test('git fixer: a driver that gives up by aborting reports failure', async () => {
  const dir = await conflictedRepo(['x.txt']);
  sh(dir, ['update-ref', 'refs/remotes/origin/other', 'other']);
  const driver: GitFixerDriver = {
    available: async () => true,
    async runSession(exec) { await exec('git merge --abort'); },
  };
  const ok = await runGitFixer(dir, hostExec(dir), 'main', driver,
    { attempts: 1 }, 'sid', 'other');
  assert.equal(ok, false);
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
test('engine + git fixer: pull conflict is resolved inside the lock and pushed', async () => {
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
    // scripted Git Fixer: keep both intents, conclude the merge
    const exec = hostExec(d);
    await exec('printf "session+base\\n" > f.txt && git add f.txt && git -c user.email=f@f -c user.name=git-fixer commit -q --no-verify -m "git fixer: merge"');
    return true;
  });
  const [workspace] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  assert.equal(await engine.push(session, workspace), 'pushed');
  // base moves to a conflicting edit AFTER the session pushed its work
  sh(seed, ['fetch', '-q', 'origin', 'main']); sh(seed, ['reset', '-q', '--hard', 'origin/main']);
  await fs.writeFile(path.join(seed, 'f.txt'), 'base-moved\n');
  sh(seed, ['add', '-A']); sh(seed, ['commit', '-qm', 'base move']); sh(seed, ['push', '-q', 'origin', 'main']);

  const result = await engine.pull(session, workspace);
  assert.equal(result, 'merged', 'the git fixer inside the lock must convert conflict to merged');
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

test('auto-push: a second auto-push after re-editing the same line does not conflict with itself', async () => {
  const t = await autoPushRoot();
  await fs.writeFile(path.join(t.dir, 'f.txt'), 'session v1\n');
  const r1 = await autoPush(t.deps(), t.session, t.workspace);
  assert.equal(r1.result, 'pushed', JSON.stringify(r1));
  // the session keeps going and re-edits the very line it just pushed
  await fs.writeFile(path.join(t.dir, 'f.txt'), 'session v2\n');
  const r2 = await autoPush(t.deps(), t.session, t.workspace);
  assert.equal(r2.result, 'pushed', 'plain merge shares history — no self-conflict');
  const now = execFileSync('git', ['-C', t.bare, 'show', 'main:f.txt'], { encoding: 'utf8' });
  assert.equal(now.trim(), 'session v2');
  await t.done();
});

test('auto-push: a conflict goes to the fixer and the resolution lands on base', async () => {
  const t = await autoPushRoot();
  await fs.writeFile(path.join(t.dir, 'f.txt'), 'session line\n');
  t.pushMain('f.txt', 'base line\n', 'base edits the same file');
  const r = await autoPush(t.deps({
    fixer: async (_s, _w, d) => {
      const exec = hostExec(d);
      await exec('printf "both lines\\n" > f.txt && git add f.txt && git -c user.email=f@f -c user.name=git-fixer commit -q --no-verify -m "git fixer: merge"');
      return true;
    },
  }), t.session, t.workspace);
  assert.equal(r.result, 'pushed', JSON.stringify(r));
  const now = execFileSync('git', ['-C', t.bare, 'show', 'main:f.txt'], { encoding: 'utf8' });
  assert.equal(now.trim(), 'both lines');
  await t.done();
});

test('auto-push: fixer fails -> blocked, base untouched, branch left as it was', async () => {
  const t = await autoPushRoot();
  await fs.writeFile(path.join(t.dir, 'f.txt'), 'session line\n');
  t.pushMain('f.txt', 'base line\n', 'conflicting base work');
  const mainBefore = t.originSha('refs/heads/main');
  const r = await autoPush(t.deps({ fixer: async () => false }), t.session, t.workspace);
  assert.equal(r.result, 'blocked', JSON.stringify(r));
  assert.equal(t.originSha('refs/heads/main'), mainBefore, 'nothing on base');
  // the merge was aborted — clean tree, the session commit still in place
  const { stdout: status } = await git(t.dir, ['status', '--porcelain']);
  assert.equal(status.trim(), '', 'no half-merged tree left behind');
  const { stdout: subject } = await git(t.dir, ['log', '--format=%s', '-1']);
  assert.match(subject, /Update f\.txt/, 'the auto-push commit survives for the next try');
  await t.done();
});

test('auto-push: base moves between merge and push -> merge again, land on round 2', async () => {
  const t = await autoPushRoot();
  await fs.writeFile(path.join(t.dir, 'work.txt'), 'race work\n');
  let raced = false;
  const events: AutoPushEvent[] = [];
  const r = await autoPush(t.deps({
    onEvent: (e) => {
      events.push(e);
      // The window step 7 exists for: after our merge+verify, before our push
      // to base, someone lands on main.
      if (e.step === 'push_base' && !raced) {
        raced = true;
        t.pushMain('race.txt', 'raced in\n', 'race');
      }
    },
  }), t.session, t.workspace);
  assert.equal(r.result, 'pushed', JSON.stringify(r));
  assert.equal(r.rounds, 2, 'round 1 was rejected, round 2 landed');
  assert.ok(events.some((e) => e.step === 'retry'), 'the rejection is a step, not a silent loop');
  const tree = execFileSync('git', ['-C', t.bare, 'ls-tree', '--name-only', 'main'], { encoding: 'utf8' });
  assert.match(tree, /work\.txt/); assert.match(tree, /race\.txt/);
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
