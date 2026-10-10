// In-memory singleton for a running update: the SDK's half of an update.
// It pulls the images a deployment strategy names through Images (the one
// puller — nothing removes an image while it runs), calls the strategy's
// apply, and streams progress to every attached listener (CLI, Telegram,
// reconnects). The update survives client disconnects — listeners are just
// observers. What the apply DOES to the stack is the strategy's (the app's,
// or sidecar.ts for the sidecar it may choose): nothing here knows an image
// name, a compose file or a .env.
//
// Lifecycle (the event shapes and their wording: @phantom-agent-sdk/client update.ts):
//   1. pull every image in parallel — `pulling` per image, then `pulled`.
//      The first image is this process's own: its pull must succeed; the
//      rest are tolerated (the api pulls a session image on first use).
//   2. the strategy's apply — each line it reports goes out as `installing`
//   3. the apply replaces this process. The shutdown handler calls
//      `shutdown()` here FIRST, so the stream ends with `restarting` — and
//      every line relayed so far goes out — before the server force-closes
//      its connections. The client then health-polls the new process. An
//      apply that resolves without that restart is `restarting` too (the
//      restart is pending); one that throws is an `error` with its reason.
import type Docker from 'dockerode';
import type { Images } from '../runtime/Images.js';
import type { UpdateEvent } from '@phantom-agent-sdk/client';
import { logger, errStr } from '../lib/log.js';

const log = logger('update-task');

export type UpdateListener = (event: UpdateEvent) => void;

/** An image a release tag means: its name in the progress line, its ref. */
export interface ImageRef { name: string; ref: string }

/** What replaces the running stack with a tag, once its images are on disk.
 *  Resolves when the hand-off is done (the process going down IS the
 *  update); throws with the reason when it cannot. Progress lines through
 *  `report`. */
export type ApplyFn = (tag: string, deps: { docker: Docker; report: (line: string) => void }) => Promise<void>;

export interface UpdateDeps {
  images: Images;
  docker: Docker;
  /** The images to pull, this process's own first. */
  refs: ImageRef[];
  apply: ApplyFn;
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

function emit(event: UpdateEvent) {
  if (!current) return;
  if (event.event === 'pulling') {
    current.events = current.events.filter((kept) => !(kept.event === 'pulling' && kept.image === event.image));
  }
  current.events.push(event);
  for (const listener of current.listeners) {
    try { listener(event); } catch (error) { log.warn({ err: errStr(error) }, 'update listener threw'); }
  }
}

/** Attach a listener to the running task. Returns an unsubscribe function,
 *  or null when nothing is running. The listener first receives the events
 *  so far (replay). */
export function subscribe(listener: UpdateListener): (() => void) | null {
  if (!current) return null;
  for (const event of current.events) {
    try { listener(event); } catch (error) { log.warn({ err: errStr(error) }, 'update listener threw'); }
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
  const pulled = current!.events.some((event) => event.event === 'pulled');
  emit(pulled ? { event: 'restarting' } : { event: 'error', message: 'the server restarted before the images were pulled' });
  current!.done = true;
}

/** Start the update task. Returns false if one is already running. */
export function startUpdate(deps: UpdateDeps, tag: string): boolean {
  if (current && !current.done) return false;
  current = { tag, events: [], done: false, listeners: new Set() };
  // Fire and forget — the task owns its lifecycle.
  runUpdate(deps, tag).catch((error) => {
    log.error({ err: errStr(error), tag }, 'update task failed');
    emit({ event: 'error', message: errStr(error) });
  }).finally(() => { if (current) current.done = true; });
  return true;
}

async function runUpdate(deps: UpdateDeps, tag: string): Promise<void> {
  const [own, ...rest] = deps.refs;
  if (!own) throw new Error('the deployment names no image for this tag');
  log.info({ tag, refs: deps.refs.map((image) => image.ref) }, 'update: pulling images');

  // ── 1. pull ───────────────────────────────────────────────────────────────
  const results = await Promise.allSettled(deps.refs.map((image) =>
    deps.images.pull(image.ref, (progress) => emit({ event: 'pulling', image: image.name, ...progress }))));
  const [ownResult, ...restResults] = results;
  if (ownResult.status === 'rejected') {
    // A failed pull of an image already here (a re-run after a network blip)
    // is not a failure.
    try {
      await deps.images.inspect(own.ref);
      log.warn({ tag }, `${own.name} image pull failed but image exists locally`);
    } catch {
      emit({ event: 'error', message: `Failed to pull ${own.name} image: ${errStr(ownResult.reason)}` });
      return;
    }
  }
  restResults.forEach((result, index) => {
    if (result.status === 'rejected') log.warn({ tag, err: errStr(result.reason) }, `${rest[index].name} image pull failed — pulled on first use`);
  });
  emit({ event: 'pulled' });

  // ── 2. apply ──────────────────────────────────────────────────────────────
  try {
    await deps.apply(tag, { docker: deps.docker, report: (line) => emit({ event: 'installing', message: line }) });
  } catch (error) {
    if (current?.done) return;
    emit({ event: 'error', message: errStr(error) });
    return;
  }
  // Still here: the apply is done and the restart pending — or the shutdown
  // already answered.
  if (current?.done) return;
  emit({ event: 'restarting' });
}
