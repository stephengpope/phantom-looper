// The sidecar apply: ONE way to replace a running stack that an app may hand
// its deployment strategy (DeploymentStrategy.apply), and the session
// runner's own. The tag is written to a trigger file on a shared volume; a
// sidecar holding the docker socket (updater/watch.sh in phantom-looper)
// polls it and spawns a one-shot helper container that recreates the stack.
// Nothing here knows an image name, a compose file or a .env: the helper's
// script is the deployment's, outside the SDK. What this knows is the file,
// the helper's name, and how to follow it:
//   1. write the trigger file
//   2. wait for the helper container the sidecar spawns for THIS request
//   3. relay its output line by line — the same text `docker logs
//      phantom-update-run` shows a human, so a failure reaches the client
//      the second it prints, with its reason
//   4. the helper's `compose up` stops this process (the update); a helper
//      that exits non-zero without that restart is the failure path
import type Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ApplyFn } from './updateTask.js';
import { logger } from '../lib/log.js';

const log = logger('update-sidecar');

/** The helper container's name — set by updater/watch.sh, read here. */
export const HELPER_NAME = 'phantom-update-run';
/** How long the sidecar gets to pick up the trigger (it polls every 3s). */
const HELPER_WAIT_MS = 30_000;

export interface SidecarOptions {
  /** Where the release tag is dropped for the sidecar (UPDATE_TRIGGER_DIR). */
  triggerDir: string;
  /** The helper container's name, when the stack sets one (HELPER_NAME): a
   *  runner on the same daemon as a server must not read the server's. */
  helperName?: string;
}

/** An apply that hands the tag to the updater sidecar and follows its helper. */
export function sidecarApply(options: SidecarOptions): ApplyFn {
  const helperName = options.helperName ?? HELPER_NAME;
  return async (tag, { docker, report }) => {
    // The previous run's helper is kept for its logs (watch.sh) — note its id
    // so the new one is told apart from it.
    const previous = await helperId(docker, helperName);
    await fs.writeFile(path.join(options.triggerDir, 'request'), `${tag}\n`);
    log.info({ tag }, 'update: trigger written');

    const helper = await waitForHelper(docker, previous, helperName);
    if (!helper) throw new Error('the updater sidecar did not pick up the request — is the `updater` service running? (phantom-backend status)');
    const lines: string[] = [];
    await followLogs(helper, (line) => { lines.push(line); report(line); });

    // Still here: the helper finished without replacing this process — or
    // the shutdown already answered (its log stream dies with the process).
    const { State } = await helper.inspect();
    if (State.ExitCode === 0) { log.info({ tag }, 'update: helper finished, restart pending'); return; }
    log.error({ tag, exitCode: State.ExitCode, lines }, 'update: helper failed');
    throw new Error(`the installer stopped (exit ${State.ExitCode}): ${lines.slice(-3).join(' · ') || 'no output'}`);
  };
}

async function helperId(docker: Docker, name: string): Promise<string | null> {
  try { return (await docker.getContainer(name).inspect()).Id; } catch { return null; }
}

/** The helper container watch.sh spawns for THIS request — a container by
 *  that name whose id differs from the previous run's. */
async function waitForHelper(docker: Docker, previous: string | null, name: string): Promise<Docker.Container | null> {
  const deadline = Date.now() + HELPER_WAIT_MS;
  while (Date.now() < deadline) {
    const id = await helperId(docker, name);
    if (id && id !== previous) return docker.getContainer(id);
    await new Promise((wake) => setTimeout(wake, 1000));
  }
  return null;
}

/** Relay the container's output line by line until it stops. stdout and
 *  stderr arrive multiplexed over the socket (no tty); one demux, one order. */
async function followLogs(container: Docker.Container, onLine: (line: string) => void): Promise<void> {
  const raw = await container.logs({ follow: true, stdout: true, stderr: true });
  const out = new PassThrough();
  container.modem.demuxStream(raw, out, out);
  let buf = '';
  out.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let newlineAt: number;
    while ((newlineAt = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, newlineAt).trimEnd();
      buf = buf.slice(newlineAt + 1);
      if (line) onLine(line);
    }
  });
  await new Promise<void>((resolve) => { raw.on('end', resolve); raw.on('close', resolve); raw.on('error', resolve); });
  if (buf.trim()) onLine(buf.trimEnd());
}
