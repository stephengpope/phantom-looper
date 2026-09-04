// Docker-in-the-workspace, for real: a privileged container from an image that
// carries dockerd, brought up by the SAME start-docker the production image
// ships, reached by the agent user with no sudo, on the overlay2 graph driver
// (the whole point of the /var/lib/docker volume — vfs would mean it "works"
// but unusably slowly). The container is created through ContainerManager, so
// buildContainerSpec's privileged + graph-volume wiring is exercised live, not
// just in unit.test.ts. Skipped automatically where a privileged nested dockerd
// cannot run.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { testDb, testRoot, setWorkspaceSetting } from './harness.js';
import { makePaths, sessionDir, type Paths } from '../phantom-backend/pool/paths.js';
import { makeDocker } from '../phantom-backend/docker.js';
import { ContainerManager } from '../phantom-backend/workspace/container.js';
import { Sandbox } from '../phantom-backend/workspace/sandbox.js';
import { newId } from '../core/ids.js';

const DIND_IMAGE = 'phantom-test-dind';

// Same start-docker the real Dockerfile bakes — kept in lockstep by eye; a drift
// here is a drift the agent would hit.
const START_DOCKER = [
  '#!/bin/sh',
  'if docker info >/dev/null 2>&1; then exit 0; fi',
  'sudo sh -c "dockerd >/var/log/dockerd.log 2>&1 &"',
  'for _ in $(seq 1 40); do',
  '  docker info >/dev/null 2>&1 && exit 0',
  '  sleep 0.5',
  'done',
  'echo "dockerd did not come up; see /var/log/dockerd.log" >&2',
  'tail -n 20 /var/log/dockerd.log >&2 2>/dev/null || true',
  'exit 1',
].join('\n');

function sh(cmd: string, args: string[], opts: { ignore?: boolean } = {}) {
  return execFileSync(cmd, args, { stdio: opts.ignore ? 'ignore' : 'pipe', encoding: 'utf8' });
}

/** Alpine + the full docker engine + an `agent` user in the docker group, USER
 *  agent — the minimum that mirrors the production image's docker surface. */
async function ensureDindImage(): Promise<void> {
  try { sh('docker', ['image', 'inspect', DIND_IMAGE], { ignore: true }); return; } catch { /* build */ }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-dind-'));
  await fs.writeFile(path.join(dir, 'start-docker'), START_DOCKER, { mode: 0o755 });
  await fs.writeFile(path.join(dir, 'Dockerfile'), [
    'FROM alpine:3.20',
    'RUN apk add --no-cache docker ripgrep git sudo shadow',
    'RUN adduser -D -u 1000 agent && addgroup agent docker \\',
    "  && echo 'agent ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/agent && chmod 0440 /etc/sudoers.d/agent",
    'COPY start-docker /usr/local/bin/start-docker',
    'RUN chmod 755 /usr/local/bin/start-docker && mkdir -p /workspace/repo && chown -R 1000:1000 /workspace',
    'USER agent',
    'WORKDIR /workspace/repo',
  ].join('\n'));
  sh('docker', ['build', '-t', DIND_IMAGE, dir], { ignore: true });
}

let db: ReturnType<typeof makeDb>['db'];
let pgPool: ReturnType<typeof makeDb>['pool'];
let paths: Paths;
let root: string;
let containers: ContainerManager;
let workspace: { id: string };
let session: { id: string; folderId: string };
let supported = true;

import { makeDb } from '../phantom-backend/db/client.js';
import { workspaces } from '../phantom-backend/db/schema.js';

before(async () => {
  try { await ensureDindImage(); }
  catch { supported = false; return; } // no docker to build with, or build blocked
  ({ db, pool: pgPool } = await testDb('dind'));
  root = await testRoot('phantom-dind-');
  paths = makePaths(path.join(root, 'workspaces'));

  const wsId = newId();
  await db.insert(workspaces).values({
    id: wsId, url: 'file:///none', owner: 'local', name: 'dind',
    baseBranch: 'main', branchPrefix: 'agent', schemaName: `repo_${wsId}`,
  });
  await setWorkspaceSetting(db, wsId, 'container_image', DIND_IMAGE);
  await setWorkspaceSetting(db, wsId, 'container_docker', true);
  workspace = { id: wsId };

  const sid = newId();
  session = { id: sid, folderId: sid };
  // The bind mount + WorkingDir need to exist on the host.
  await fs.mkdir(path.join(sessionDir(paths, sid), 'repo'), { recursive: true });

  containers = new ContainerManager(makeDocker(), paths);
  await containers.bootCleanup();
});

after(async () => {
  await containers?.remove(session.id);
  await pgPool?.end();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test('a container_docker workspace is privileged and carries an anonymous graph volume', async (t) => {
  if (!supported) return t.skip('no docker available to build the DinD test image');
  await containers.ensure(db, session as any, workspace as any);
  const info = await makeDocker().getContainer(`phantom-looper-ws-${session.id}`).inspect();
  assert.equal(info.HostConfig.Privileged, true, 'container_docker=on must create privileged');
  const graph = (info.Mounts as Array<{ Destination: string; Name?: string }>)
    .find((m) => m.Destination === '/var/lib/docker');
  assert.ok(graph, '/var/lib/docker is mounted');
  assert.ok(graph!.Name, 'it is a named (anonymous) volume, not the container layer');
});

test('start-docker brings dockerd up; the agent uses it without sudo, on overlay2', async (t) => {
  if (!supported) return t.skip('no docker available to build the DinD test image');
  const c = await containers.ensure(db, session as any, workspace as any);
  const ws = new Sandbox(makeDocker(), c);

  // The daemon is NOT running until the agent asks — the invariant the whole
  // design turns on.
  const before = await ws.run(['docker', 'info'], { cwd: '/' });
  assert.notEqual(before.exitCode, 0, 'dockerd must not be auto-started');

  const up = await ws.run(['start-docker'], { cwd: '/', timeoutMs: 60_000 });
  assert.equal(up.exitCode, 0, `start-docker failed: ${up.stderr.toString()}`);

  // Reachable as the agent user with no sudo (the docker group), and idempotent.
  const again = await ws.run(['start-docker'], { cwd: '/' });
  assert.equal(again.exitCode, 0, 'start-docker is a no-op once up');

  const driver = await ws.run(['docker', 'info', '-f', '{{.Driver}}'], { cwd: '/' });
  assert.equal(driver.exitCode, 0, driver.stderr.toString());
  assert.equal(driver.stdout.toString().trim(), 'overlay2',
    'the graph volume must give native overlay2, never the vfs fallback');
});
