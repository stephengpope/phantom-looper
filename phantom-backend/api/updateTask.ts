// In-memory singleton for a running update. The API pulls images through
// Images (the one puller — nothing removes an image while it runs) and
// streams progress to every attached listener (CLI, Telegram, reconnects).
// The update survives client disconnects — listeners are just observers.
//
// Lifecycle (the event shapes and their wording: core/update.ts):
//   1. pull both images in parallel — `pulling` per image, then `pulled`
//   2. write the trigger file; the updater sidecar (updater/watch.sh) spawns
//      the helper container that runs updater/apply.sh
//   3. follow the helper's output line by line as `installing` — the same
//      text `docker logs phantom-update-run` shows a human, so a failure
//      reaches the client the second it prints, with its reason
//   4. the helper's `compose up` stops this container. The shutdown handler
//      (index.ts) calls `shutdown()` here FIRST, so the stream ends with
//      `restarting` — and every line relayed so far goes out — before the
//      server force-closes its connections (which drops whatever a socket
//      still holds). The client then health-polls the new api. A helper that
//      exits on its own without that restart is the failure path — non-zero
//      is an `error` carrying its last lines.
import type Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Images } from '../images.js';
import type { UpdateEvent } from '../../core/update.js';
import { logger, errStr } from '../log.js';

const log = logger('update-task');

/** The helper container's name — set by updater/watch.sh, read here. */
export const HELPER_NAME = 'phantom-update-run';
/** How long the sidecar gets to pick up the trigger (it polls every 3s). */
const HELPER_WAIT_MS = 30_000;

export type UpdateListener = (e: UpdateEvent) => void;

export interface UpdateDeps {
  images: Images;
  docker: Docker;
  triggerDir: string;
  apiImage: string;
  sessionImage: string;
}

// ── the task ────────────────────────────────────────────────────────────────
interface Task {
  tag: string;
  /** Progress so far — a reconnecting client gets it replayed. One `pulling`
   *  per image (the latest), every other event in order. */
  events: UpdateEvent[];
  done: boolean;
  listeners: Set<UpdateListener>;
}

let current: Task | null = null;

function emit(e: UpdateEvent) {
  if (!current) return;
  if (e.event === 'pulling') {
    current.events = current.events.filter((ev) => !(ev.event === 'pulling' && ev.image === e.image));
  }
  current.events.push(e);
  for (const fn of current.listeners) {
    try { fn(e); } catch {}
  }
}

/** Attach a listener to the running task. Returns an unsubscribe function,
 *  or null when nothing is running. The listener first receives the events
 *  so far (replay). */
export function subscribe(listener: UpdateListener): (() => void) | null {
  if (!current) return null;
  for (const e of current.events) {
    try { listener(e); } catch {}
  }
  current.listeners.add(listener);
  return () => { current?.listeners.delete(listener); };
}

/** Is an update in progress? */
export function isRunning(): boolean { return current !== null && !current.done; }

/** The process is going down. Past `pulled` that is the update's own
 *  restart — say so; before it, the pull is being cut short — a failure. */
export function shutdown(): void {
  if (!isRunning()) return;
  const pulled = current!.events.some((e) => e.event === 'pulled');
  emit(pulled ? { event: 'restarting' } : { event: 'error', message: 'the server restarted before the images were pulled' });
  current!.done = true;
}

/** Start the update task. Returns false if one is already running. */
export function startUpdate(deps: UpdateDeps, tag: string): boolean {
  if (current && !current.done) return false;
  current = { tag, events: [], done: false, listeners: new Set() };
  // Fire and forget — the task owns its lifecycle.
  runUpdate(deps, tag).catch((e) => {
    log.error({ err: errStr(e), tag }, 'update task failed');
    emit({ event: 'error', message: errStr(e) });
  }).finally(() => { if (current) current.done = true; });
  return true;
}

async function runUpdate(deps: UpdateDeps, tag: string): Promise<void> {
  const apiRef = `${deps.apiImage}:${tag}`;
  const sessionRef = `${deps.sessionImage}:${tag}`;
  log.info({ tag, apiRef, sessionRef }, 'update: pulling images');

  // ── 1. pull ───────────────────────────────────────────────────────────────
  const [apiResult, sessionResult] = await Promise.allSettled([
    deps.images.pull(apiRef, (p) => emit({ event: 'pulling', image: 'api', ...p })),
    deps.images.pull(sessionRef, (p) => emit({ event: 'pulling', image: 'session', ...p })),
  ]);
  if (apiResult.status === 'rejected') {
    // A failed pull of an image already here (a re-run after a network blip)
    // is not a failure.
    try {
      await deps.images.inspect(apiRef);
      log.warn({ tag }, 'api image pull failed but image exists locally');
    } catch {
      emit({ event: 'error', message: `Failed to pull api image: ${errStr(apiResult.reason)}` });
      return;
    }
  }
  if (sessionResult.status === 'rejected') {
    // Tolerated: the api pulls the session image on first use.
    log.warn({ tag, err: errStr(sessionResult.reason) }, 'session image pull failed — api will pull on first use');
  }
  emit({ event: 'pulled' });

  // ── 2. hand off to the sidecar ────────────────────────────────────────────
  // The previous run's helper is kept for its logs (watch.sh) — note its id
  // so the new one is told apart from it.
  const previous = await helperId(deps.docker);
  await fs.writeFile(path.join(deps.triggerDir, 'request'), `${tag}\n`);
  log.info({ tag }, 'update: trigger written');

  // ── 3. follow the helper ──────────────────────────────────────────────────
  const helper = await waitForHelper(deps.docker, previous);
  if (!helper) {
    emit({ event: 'error', message: 'the updater sidecar did not pick up the request — is the `updater` service running? (phantom-backend status)' });
    return;
  }
  const lines: string[] = [];
  await followLogs(helper, (line) => { lines.push(line); emit({ event: 'installing', message: line }); });

  // Still here: the helper finished without replacing this container — or
  // the shutdown already answered (its log stream dies with the process).
  if (current?.done) return;
  const { State } = await helper.inspect();
  if (State.ExitCode === 0) {
    log.info({ tag }, 'update: helper finished, restart pending');
    emit({ event: 'restarting' });
    return;
  }
  log.error({ tag, exitCode: State.ExitCode, lines }, 'update: helper failed');
  emit({ event: 'error', message: `the installer stopped (exit ${State.ExitCode}): ${lines.slice(-3).join(' · ') || 'no output'}` });
}

async function helperId(docker: Docker): Promise<string | null> {
  try { return (await docker.getContainer(HELPER_NAME).inspect()).Id; } catch { return null; }
}

/** The helper container watch.sh spawns for THIS request — a container by
 *  that name whose id differs from the previous run's. */
async function waitForHelper(docker: Docker, previous: string | null): Promise<Docker.Container | null> {
  const deadline = Date.now() + HELPER_WAIT_MS;
  while (Date.now() < deadline) {
    const id = await helperId(docker);
    if (id && id !== previous) return docker.getContainer(id);
    await new Promise((r) => setTimeout(r, 1000));
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
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trimEnd();
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
    }
  });
  await new Promise<void>((resolve) => { raw.on('end', resolve); raw.on('close', resolve); raw.on('error', resolve); });
  if (buf.trim()) onLine(buf.trimEnd());
}
