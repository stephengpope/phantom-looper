// Self-update, without a network: version compares (what nags and what never
// does), asset naming, checksum policy, and the full download→verify→unpack→
// re-link path against an injected fetch and a temp HOME.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseVersion, isBehind, platformAsset, checksumFor, selfUpdate, APP_VERSION } from './selfUpdate.js';

test('parseVersion: releases parse, everything else is null', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('0.10.0'), [0, 10, 0]);
  assert.equal(parseVersion('dev'), null);
  assert.equal(parseVersion('v1.2.3-rc1'), null);   // prereleases never compare
  assert.equal(parseVersion(''), null);
});

test('isBehind: numeric compare; dev and prereleases are never behind', () => {
  assert.equal(isBehind('v0.1.0', 'v0.2.0'), true);
  assert.equal(isBehind('0.2.0', 'v0.2.0'), false);
  assert.equal(isBehind('v0.10.0', 'v0.9.0'), false);   // 10 > 9, not string order
  assert.equal(isBehind('v0.9.0', 'v0.10.0'), true);
  assert.equal(isBehind('dev', 'v99.0.0'), false);
  assert.equal(isBehind('v0.1.0', 'v0.2.0-rc1'), false);
});

test('platformAsset: the four builds, and a clear refusal elsewhere', () => {
  assert.equal(platformAsset('darwin', 'arm64'), 'phantom-cli-darwin-arm64.tar.gz');
  assert.equal(platformAsset('linux', 'x64'), 'phantom-cli-linux-x64.tar.gz');
  assert.throws(() => platformAsset('win32', 'x64'), /no phantom-cli build/);
});

test('checksumFor: finds the asset line, ignores the rest', () => {
  const sums = `${'a'.repeat(64)}  phantom-cli-linux-x64.tar.gz\n${'b'.repeat(64)}  phantom-cli-darwin-arm64.tar.gz\n`;
  assert.equal(checksumFor(sums, 'phantom-cli-darwin-arm64.tar.gz'), 'b'.repeat(64));
  assert.equal(checksumFor(sums, 'phantom-cli-darwin-x64.tar.gz'), null);
});

// A real miniature release: a tarball with the shipped layout, a checksums
// file, both served by a stubbed fetch.
function makeRelease(tmp: string) {
  const stage = join(tmp, 'stage', 'phantom-cli');
  mkdirSync(join(stage, 'bin'), { recursive: true });
  writeFileSync(join(stage, 'bin', 'phantom-cli'), '#!/bin/sh\necho new-version\n', { mode: 0o755 });
  writeFileSync(join(stage, 'VERSION'), '9.9.9\n');
  const asset = platformAsset();
  const tarPath = join(tmp, asset);
  execFileSync('tar', ['-C', join(tmp, 'stage'), '-czf', tarPath, 'phantom-cli']);
  const tarball = readFileSync(tarPath);
  const sum = createHash('sha256').update(tarball).digest('hex');
  return { tarball, checksums: `${sum}  ${asset}\n`, asset };
}

const fetchFor = (bodies: Record<string, Buffer | string>): typeof fetch =>
  (async (url: unknown) => {
    const name = String(url).split('/').pop()!;
    const body = bodies[name];
    if (body === undefined) return new Response('nope', { status: 404 });
    return new Response(body as BodyInit, { status: 200 });
  }) as typeof fetch;

test('selfUpdate: refuses to run from a checkout', async () => {
  assert.equal(APP_VERSION, 'dev');   // tests run on tsx, never a release build
  await assert.rejects(() => selfUpdate('v9.9.9'), /git pull/);
});

test('selfUpdate: download, verify, unpack, re-link (release build simulated)', async (t) => {
  // APP_VERSION is baked at build; simulate a release build for this test.
  process.env.PHANTOM_CLI_VERSION = '1.0.0';
  // a fresh module instance that sees the env (the query string defeats the
  // module cache; built dynamically so tsc does not try to resolve it)
  const spec = './selfUpdate.js' + '?release-sim';
  const mod = await import(spec) as typeof import('./selfUpdate.js');
  t.after(() => { delete process.env.PHANTOM_CLI_VERSION; });

  const tmp = mkdtempSync('/tmp/phantom-update-');
  const { tarball, checksums } = makeRelease(tmp);
  const home = join(tmp, 'home');
  const dir = join(home, '.phantom-cli');
  const binDir = join(home, '.local', 'bin');

  const line = await mod.selfUpdate('v9.9.9', {
    fetchFn: fetchFor({ [platformAsset()]: tarball, 'checksums.txt': checksums }),
    dir, binDir,
  });
  assert.match(line, /9\.9\.9 installed/);
  const link = join(binDir, 'phantom-cli');
  assert.equal(readlinkSync(link), join(home, '.phantom-cli', 'app', '9.9.9', 'bin', 'phantom-cli'));
  assert.equal(readFileSync(join(home, '.phantom-cli', 'app', '9.9.9', 'VERSION'), 'utf8').trim(), '9.9.9');

  // a corrupted download is refused whole — nothing on disk changes
  await assert.rejects(() => mod.selfUpdate('v9.9.10', {
    fetchFn: fetchFor({ [platformAsset()]: Buffer.concat([tarball, Buffer.from('tampered')]), 'checksums.txt': checksums }),
    dir, binDir,
  }), /checksum mismatch/);
  assert.equal(existsSync(join(home, '.phantom-cli', 'app', '9.9.10')), false);
  assert.equal(readlinkSync(link), join(home, '.phantom-cli', 'app', '9.9.9', 'bin', 'phantom-cli'));
});
