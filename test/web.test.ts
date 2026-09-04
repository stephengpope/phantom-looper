// The /web routes against a fake Firecrawl (FIRECRAWL_API_BASE, the same
// seam phase4 uses for GitHub): real Postgres, a real session over a file://
// origin, no Docker — fetched pages are written host-side. Pins the pass-
// through contract: Firecrawl's own statusCode/code/error reach the caller,
// the one retry goes through the enhanced proxy, and files land in
// work/<session>/web/, outside the repo.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { testDb } from './harness.js';
import { makeDb } from '../phantom-backend/db/client.js';
import { workspaces } from '../phantom-backend/db/schema.js';
import { newId } from '../core/ids.js';
import { makePaths, sessionDir, type Paths } from '../phantom-backend/pool/paths.js';
import { bootCleanup } from '../phantom-backend/pool/pool.js';
import { buildApp } from '../phantom-backend/api/app.js';
import { urlSlug } from '../phantom-backend/api/routes/web.js';

let db: ReturnType<typeof makeDb>['db'];
let pgPool: ReturnType<typeof makeDb>['pool'];
let app: Awaited<ReturnType<typeof buildApp>>;
let paths: Paths;
let root: string;
let fake: http.Server;
let sessionId: string;

/** Every scrape request body, in arrival order — the retry assertions read it. */
const scrapes: Record<string, any>[] = [];
let searches: Record<string, any>[] = [];

const PAGES: Record<string, (body: Record<string, any>) => unknown> = {
  'http://ok.test/page': () => ({ success: true, data: {
    markdown: '# Hello\n\nreal content', metadata: { statusCode: 200, title: 'OK Page' } } }),
  'https://ok.test/page': () => ({ success: true, data: {
    markdown: 'the https twin', metadata: { statusCode: 200, title: 'OK Page (https)' } } }),
  'http://gone.test/x': () => ({ success: true, data: {
    markdown: 'not found page body', metadata: { statusCode: 404, title: 'Page not found' } } }),
  // Empty until the enhanced-proxy retry — the JS-wall case.
  'http://blocked.test/js': (body) => body.proxy === 'enhanced'
    ? { success: true, data: { markdown: 'rendered after wait', metadata: { statusCode: 200, title: 'JS Page' } } }
    : { success: true, data: { markdown: '', metadata: { statusCode: 200 } } },
  'http://dead.test/x': () => ({ success: false,
    code: 'SCRAPE_DNS_RESOLUTION_ERROR', error: 'DNS resolution failed for hostname "dead.test".' }),
};

before(async () => {
  ({ db, pool: pgPool } = await testDb('web'));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-web-'));
  paths = makePaths(path.join(root, 'workspaces'));
  await bootCleanup(paths);

  // A one-commit file:// origin — enough for a real session to exist.
  const bare = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['clone', '-q', bare, seed]);
  const sh = (args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t',
    '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false',
    '-c', 'protocol.file.allow=always', ...args], { cwd: seed, encoding: 'utf8' });
  sh(['checkout', '-qb', 'main']);
  await fs.writeFile(path.join(seed, 'a.txt'), 'one\n');
  sh(['add', '-A']); sh(['commit', '-qm', 'first']); sh(['push', '-q', 'origin', 'main']);

  // The fake Firecrawl.
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      let answer: unknown;
      if (req.url === '/v2/search') {
        searches.push(body);
        answer = { success: true, data: { web: [
          { title: 'Long', url: 'http://long.test', description: 'x'.repeat(1000), position: 1 },
          { title: 'Short', url: 'http://short.test', description: 'a short snippet', position: 2 },
        ] } };
      } else if (req.url === '/v2/scrape') {
        scrapes.push(body);
        answer = PAGES[body.url]?.(body) ?? { success: false, code: 'UNKNOWN', error: 'unscripted url' };
      } else {
        res.statusCode = 404; res.end('{}'); return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const port = (fake.address() as { port: number }).port;
  process.env.FIRECRAWL_API_BASE = `http://127.0.0.1:${port}`;

  app = await buildApp({
    db, paths, apiKey: 'test-key', encryptionKey: Buffer.alloc(32, 9), version: 'test', pgPool,
  });
  // file:// is not a registrable URL over the API — the row goes in directly,
  // the same as integration.test.ts.
  const wid = newId();
  await db.insert(workspaces).values({
    id: wid, url: `file://${bare}`, owner: 'local', name: 'webtest',
    baseBranch: 'main', branchPrefix: 'agent', schemaName: `wsp_${wid}`,
  });
  const created = await app.inject({ method: 'POST', url: '/sessions', headers: H,
    payload: { workspace_id: wid } });
  assert.equal(created.statusCode, 201, created.body);
  sessionId = json(created).data.id;
});

after(async () => {
  delete process.env.FIRECRAWL_API_BASE;
  await new Promise<void>((r) => fake?.close(() => r()));
  await app?.close();
  await pgPool?.end();
  await fs.rm(root, { recursive: true, force: true });
});

const H = { authorization: 'Bearer test-key' };
const json = (r: { body: string }) => JSON.parse(r.body);

test('no key: both routes fail with credential_required naming the secret; a saved key unblocks the NEXT call', async () => {
  for (const [url, payload] of [
    ['/web/search', { query: 'q' }],
    ['/web/fetch', { urls: ['http://ok.test/page'] }],
  ] as const) {
    const r = await app.inject({ method: 'POST', url, headers: { ...H, 'x-phantom-looper-session': sessionId }, payload });
    assert.equal(r.statusCode, 400, url);
    assert.equal(json(r).error.code, 'credential_required');
    assert.match(json(r).error.message, /firecrawl_api_key/, 'the error says where the key goes');
  }
  // Saving the key needs no restart and no new session — read at the point of use.
  const put = await app.inject({ method: 'PATCH', url: '/settings', headers: H,
    payload: { firecrawl_api_key: 'fc-test' } });
  assert.equal(put.statusCode, 200);
});

test('search: query+limit go upstream; results map to title/url/snippet with the snippet clipped', async () => {
  const r = await app.inject({ method: 'POST', url: '/web/search', headers: H,
    payload: { query: 'anything', limit: 2 } });
  assert.equal(r.statusCode, 200);
  const data = json(r).data;
  assert.deepEqual(searches.at(-1), { query: 'anything', limit: 2 });
  assert.equal(data.length, 2);
  assert.deepEqual(Object.keys(data[0]), ['title', 'url', 'snippet']);
  assert.equal(data[0].snippet.length, 300, 'a page-of-markdown description is clipped to a snippet');
  assert.equal(data[1].snippet, 'a short snippet');
});

test('search: filters pass through verbatim when given, are absent upstream when left out', async () => {
  const r = await app.inject({ method: 'POST', url: '/web/search', headers: H,
    payload: { query: 'q', tbs: 'sbd:1,qdr:w', categories: ['github'],
      excludeDomains: ['reddit.com'] } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(searches.at(-1), { query: 'q', limit: 5, tbs: 'sbd:1,qdr:w',
    categories: ['github'], excludeDomains: ['reddit.com'] },
    'given filters go up under Firecrawl\'s own names; includeDomains was left out and stays out');
  const bad = await app.inject({ method: 'POST', url: '/web/search', headers: H,
    payload: { query: 'q', categories: ['blogs'] } });
  assert.equal(bad.statusCode, 400, 'an unknown category is invalid_args, not forwarded');
});

test('search: limit defaults to 5 and validation caps it at 25', async () => {
  await app.inject({ method: 'POST', url: '/web/search', headers: H, payload: { query: 'q' } });
  assert.equal(searches.at(-1)?.limit, 5);
  const over = await app.inject({ method: 'POST', url: '/web/search', headers: H,
    payload: { query: 'q', limit: 100 } });
  assert.equal(over.statusCode, 400, 'schema-declared like every route: invalid_args, not a silent clamp');
});

test('fetch: parallel per-URL entries in input order — files, pass-through status codes, verbatim upstream errors', async () => {
  const urls = ['http://ok.test/page', 'http://gone.test/x', 'http://blocked.test/js',
    'http://dead.test/x', 'https://ok.test/page'];
  const r = await app.inject({ method: 'POST', url: '/web/fetch',
    headers: { ...H, 'x-phantom-looper-session': sessionId }, payload: { urls } });
  assert.equal(r.statusCode, 200, 'a failed URL never fails the call');
  const [okPage, gone, blocked, dead, twin] = json(r).data;

  assert.deepEqual(okPage, { url: 'http://ok.test/page', status_code: 200,
    path: '/workspace/web/ok-test-page.md', title: 'OK Page', bytes: 21 });
  const host = path.join(sessionDir(paths, sessionId), 'web', 'ok-test-page.md');
  assert.equal(await fs.readFile(host, 'utf8'), '# Hello\n\nreal content',
    'written host-side under work/<id>/web/ — beside logs/, outside repo/, never committed');

  // A 404 page is still a page: Firecrawl's own statusCode passes through and
  // the body is written — no middle-man deciding it failed.
  assert.equal(gone.status_code, 404);
  assert.equal(gone.title, 'Page not found');
  assert.ok(gone.path);

  // Empty markdown → ONE retry through the enhanced proxy, uncached.
  assert.equal(blocked.title, 'JS Page');
  const blockedCalls = scrapes.filter((s) => s.url === 'http://blocked.test/js');
  assert.equal(blockedCalls.length, 2);
  assert.equal(blockedCalls[0].proxy, undefined);
  assert.equal(blockedCalls[0].maxAge, 3_600_000);
  assert.deepEqual([blockedCalls[1].proxy, blockedCalls[1].waitFor, blockedCalls[1].maxAge],
    ['enhanced', 3000, 0]);

  // A hard failure is Firecrawl's code and error, verbatim — and no retry:
  // the proxy cannot fix DNS and the attempt costs seconds.
  assert.deepEqual(dead, { url: 'http://dead.test/x', error_code: 'SCRAPE_DNS_RESOLUTION_ERROR',
    error: 'DNS resolution failed for hostname "dead.test".' });
  assert.equal(scrapes.filter((s) => s.url === 'http://dead.test/x').length, 1);

  // Two URLs, one slug — the second gets a suffix instead of clobbering.
  assert.equal(urlSlug('https://ok.test/page'), urlSlug('http://ok.test/page'));
  assert.equal(twin.path, '/workspace/web/ok-test-page-2.md');
});

test('fetch: the session header is required — the files belong to a session', async () => {
  const r = await app.inject({ method: 'POST', url: '/web/fetch', headers: H,
    payload: { urls: ['http://ok.test/page'] } });
  assert.equal(r.statusCode, 400);
  assert.equal(json(r).error.code, 'session_not_found');
});
