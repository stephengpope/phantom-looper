// The host artifacts: everything a server holds OUTSIDE the containers — the
// deploy files in the install directory, the one command on PATH, and the
// symlink pointing at it. Pure: reads the repo, no Docker.
//
// The rule these pin: the host files ship INSIDE the api image (Dockerfile,
// /host-files) and both install.sh and updater/apply.sh copy them out of the
// tagged image. The file set therefore always comes from the release being
// installed, and there is nothing on the server that can be stale. The
// alternative — a list of files fetched from GitHub, frozen in whatever script
// a box last installed — is what jammed Shockwave's boxes when a file was
// removed: the fetch 404'd, and the step that would have replaced the script
// was downstream of the fetch. So:
//
//   1. The image delivers every file the host needs.
//   2. Neither script carries a runtime-file list or fetches runtime files
//      over the network.
//   3. apply.sh moves files into place, never copies over them (it is
//      replacing itself while the shell is still reading it).
//   4. install.sh creates exactly ONE symlink on PATH, to the dispatcher.
//   5. apply.sh creates none — watch.sh mounts only the install directory
//      into the helper, which is what makes rule 4 load-bearing.
//   6. Directly-executed files ship executable (`docker cp` preserves the
//      mode the image was built with).
//   7. The update route, watch.sh and apply.sh agree on what a tag looks like.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RELEASE_TAG } from '../phantom-backend/api/routes/system.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const install = read('scripts/install.sh');
const apply = read('updater/apply.sh');
const watch = read('updater/watch.sh');
const dockerfile = read('Dockerfile');

const DISPATCHER = 'host/phantom-backend';

// Every file a server needs on the host, relative to the install directory.
// This list lives HERE and nowhere else: it is an assertion about what a
// release must deliver, not a thing any script reads.
const REQUIRED = [
  'docker-compose.yml',
  'caddy/Caddyfile',

  'updater/watch.sh',
  'updater/apply.sh',
  DISPATCHER,
];

const IMAGE_DIR = '/host-files';

// Resolve the Dockerfile's COPY lines into /host-files to the paths they land
// at, relative to the install directory. A source ending in `/` is a directory
// and contributes every file in it.
function deliveredByImage() {
  const landed = new Set<string>();
  for (const line of dockerfile.split('\n')) {
    const m = /^COPY\s+(.+)$/.exec(line.trim());
    if (!m) continue;
    const parts = m[1].trim().split(/\s+/);
    const dest = parts.pop()!;
    if (!dest.startsWith(IMAGE_DIR)) continue;
    const prefix = dest.slice(IMAGE_DIR.length).replace(/^\/+/, '');
    for (const src of parts) {
      if (src.endsWith('/')) {
        const dir = path.join(root, src);
        for (const name of fs.readdirSync(dir)) {
          if (fs.statSync(path.join(dir, name)).isFile()) landed.add(prefix + name);
        }
      } else {
        landed.add(prefix + path.basename(src));
      }
    }
  }
  return landed;
}

// Comments explain these rules, so matching raw text would flag the
// explanation as a violation. Assert against the code only.
const code = (sh: string) => sh.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

test('the image delivers every file the host needs', () => {
  const landed = deliveredByImage();
  const missing = REQUIRED.filter((f) => !landed.has(f));
  assert.deepEqual(missing, [],
    `these must be on the server but no Dockerfile COPY puts them in ${IMAGE_DIR}: ${missing.join(', ')}`);
  // And every file that IS delivered must exist in the repo with that exact layout.
  for (const f of landed) assert.ok(fs.existsSync(path.join(root, f)), `${f} is copied into ${IMAGE_DIR} but not in the repo at that path`);
});

test('neither path fetches runtime files over the network', () => {
  for (const [name, sh] of [['install.sh', install], ['apply.sh', apply]] as const) {
    assert.doesNotMatch(code(sh), /raw\.githubusercontent\.com/,
      `${name} must take the host files out of the image, not off GitHub`);
  }
});

test('apply.sh derives what to install from the image, never from a list', () => {
  assert.match(code(apply), /find \. -type f/);
  assert.doesNotMatch(code(apply), /^FILES="/m, 'apply.sh must not declare a runtime-file list');
});

test('apply.sh moves files into place and never copies over them', () => {
  assert.match(code(apply), /\bmv "\$STAGE\//);
  assert.doesNotMatch(code(apply), /\bcp\s+[^\n]*"\$PHANTOM_BACKEND_DIR/, 'copying over $PHANTOM_BACKEND_DIR truncates the running apply.sh in place');
  // A rename only works within one filesystem, so the staging dir has to sit
  // in the bind-mounted install dir rather than the container's own /tmp.
  assert.match(code(apply), /mktemp -d "\$PHANTOM_BACKEND_DIR\//);
});

test('install.sh creates exactly one symlink on PATH, to the dispatcher', () => {
  const links = [...install.matchAll(/ln -sf?\s+"?([^"\s]+)"?\s+"?(\/usr\/local\/bin\/[^"\s]+)"?/g)]
    .map((m) => ({ target: m[1], link: m[2] }));
  assert.equal(links.length, 1, `expected 1 symlink into /usr/local/bin, found ${links.length}`);
  assert.match(links[0].target, /\$DIR\/host\/phantom-backend$/);
  assert.equal(links[0].link, '/usr/local/bin/phantom-backend');
});

test('apply.sh creates no symlinks and writes nothing outside the install dir', () => {
  assert.doesNotMatch(code(apply), /\bln -s/);
  assert.doesNotMatch(code(apply), /\/usr\/local\/bin/);
});

test('the dispatcher and scripts ship executable and both paths assert it', () => {
  for (const f of [DISPATCHER, 'scripts/install.sh', 'updater/apply.sh', 'updater/watch.sh']) {
    assert.ok(fs.statSync(path.join(root, f)).mode & 0o111, `${f} must be executable in the repo`);
  }
  for (const [name, sh] of [['install.sh', install], ['apply.sh', apply]] as const) {
    assert.match(code(sh), new RegExp(`chmod 755 "\\$\\{?\\w+\\}?/${DISPATCHER}"`), `${name} must chmod 755 ${DISPATCHER}`);
  }
});

test('the route, watch.sh and apply.sh agree on what a release tag is', () => {
  // One regex, three places: the api (RELEASE_TAG), and the two shell scripts.
  // A tag lands in an image reference and in .env, so nothing looser may pass.
  const shellRe = String.raw`\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$`;
  assert.match(code(watch), new RegExp(shellRe));
  assert.match(code(apply), new RegExp(shellRe));
  for (const good of ['v0.1.0', 'v12.3.4']) assert.ok(RELEASE_TAG.test(good), good);
  for (const bad of ['0.1.0', 'v0.1', 'v0.1.0-rc1', 'latest', 'v0.1.0; rm -rf /']) assert.ok(!RELEASE_TAG.test(bad), bad);
});

test('compose reads the same trigger dir the api writes and the sidecar watches', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /UPDATE_TRIGGER_DIR: \/trigger/);
  assert.match(compose, /updater-trigger:\/trigger/);
  assert.match(code(watch), /TRIGGER_DIR:-\/trigger/);
});
