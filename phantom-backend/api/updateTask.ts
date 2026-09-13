// In-memory singleton for a running update. The API pulls images via dockerode
// and streams progress to every attached listener (CLI, Telegram, reconnects).
// The pull survives client disconnects — listeners are just observers.
//
// Lifecycle:
//   1. pull both images in parallel, emitting per-image percentage
//   2. emit "restarting"
//   3. write the trigger file for the sidecar (file extract + compose up)
//   4. done — the sidecar restarts the stack
import type Docker from 'dockerode';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger, errStr } from '../log.js';

const log = logger('update-task');

// ── event types ─────────────────────────────────────────────────────────────
export type UpdateEvent =
  | { event: 'pulling'; image: string; percent: number }
  | { event: 'pulled' }
  | { event: 'restarting' }
  | { event: 'error'; message: string }
  | { event: 'heartbeat' };

export type UpdateListener = (e: UpdateEvent) => void;

// ── per-image pull progress ─────────────────────────────────────────────────
interface LayerProgress { current: number; total: number }

function aggregatePercent(layers: Map<string, LayerProgress>): number {
  let current = 0, total = 0;
  for (const l of layers.values()) { current += l.current; total += l.total; }
  return total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
}

/** Pull one image, calling `onPercent` with the aggregate percentage as layers
 *  download. Resolves when the pull is complete. */
function pullWithProgress(
  docker: Docker, image: string, onPercent: (pct: number) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    docker.pull(image, (e: Error | null, stream: NodeJS.ReadableStream) => {
      if (e) return reject(e);
      const layers = new Map<string, LayerProgress>();
      docker.modem.followProgress(
        stream,
        (err: Error | null) => (err ? reject(err) : resolve()),
        (event: { status?: string; id?: string; progressDetail?: { current?: number; total?: number } }) => {
          if (event.id && event.progressDetail?.total) {
            layers.set(event.id, {
              current: event.progressDetail.current ?? 0,
              total: event.progressDetail.total,
            });
            onPercent(aggregatePercent(layers));
          }
          // A layer that goes straight to "Download complete" without progress
          // events is too small to matter — it doesn't affect the percentage.
        },
      );
    });
  });
}

// ── the task ────────────────────────────────────────────────────────────────
export interface UpdateTaskState {
  tag: string;
  /** Current progress snapshot — a reconnecting client gets this immediately. */
  lastEvents: UpdateEvent[];
  done: boolean;
}

let current: {
  state: UpdateTaskState;
  listeners: Set<UpdateListener>;
} | null = null;

function emit(e: UpdateEvent) {
  if (!current) return;
  // Keep the last event per type for replay on reconnect.
  if (e.event === 'pulling') {
    // Replace existing pulling event for this image.
    const img = e.image;
    current.state.lastEvents = current.state.lastEvents.filter(
      (ev) => !(ev.event === 'pulling' && (ev as { image: string }).image === img),
    );
    current.state.lastEvents.push(e);
  } else {
    current.state.lastEvents.push(e);
  }
  for (const fn of current.listeners) {
    try { fn(e); } catch {}
  }
}

/** Attach a listener to the running task. Returns an unsubscribe function.
 *  The listener immediately receives the current state (replay). */
export function subscribe(listener: UpdateListener): (() => void) | null {
  if (!current) return null;
  // Replay current state.
  for (const e of current.state.lastEvents) {
    try { listener(e); } catch {}
  }
  current.listeners.add(listener);
  return () => { current?.listeners.delete(listener); };
}

/** Is an update in progress? */
export function isRunning(): boolean { return current !== null && !current.state.done; }

/** Start the update task. Returns false if one is already running. */
export function startUpdate(
  docker: Docker, tag: string, triggerDir: string,
  apiImage: string, sessionImage: string,
): boolean {
  if (current && !current.state.done) return false;

  current = {
    state: { tag, lastEvents: [], done: false },
    listeners: new Set(),
  };

  // Fire and forget — the task owns its lifecycle.
  runUpdate(docker, tag, triggerDir, apiImage, sessionImage).catch((e) => {
    log.error({ err: errStr(e), tag }, 'update task failed');
    emit({ event: 'error', message: errStr(e) });
    if (current) current.state.done = true;
  });

  return true;
}

async function runUpdate(
  docker: Docker, tag: string, triggerDir: string,
  apiImage: string, sessionImage: string,
): Promise<void> {
  const apiRef = `${apiImage}:${tag}`;
  const sessionRef = `${sessionImage}:${tag}`;

  log.info({ tag, apiRef, sessionRef }, 'update: pulling images');

  // Pull both in parallel, streaming progress for each.
  const apiPull = pullWithProgress(docker, apiRef, (pct) => {
    emit({ event: 'pulling', image: 'api', percent: pct });
  });
  const sessionPull = pullWithProgress(docker, sessionRef, (pct) => {
    emit({ event: 'pulling', image: 'session', percent: pct });
  });

  // Wait for both. If session fails, log it but continue — apply.sh already
  // tolerates a missing session image (the api pulls it on first use).
  const [apiResult, sessionResult] = await Promise.allSettled([apiPull, sessionPull]);

  if (apiResult.status === 'rejected') {
    // Check if image already exists locally.
    try {
      await docker.getImage(apiRef).inspect();
      log.warn({ tag }, 'api image pull failed but image exists locally');
    } catch {
      emit({ event: 'error', message: `Failed to pull api image: ${errStr(apiResult.reason)}` });
      if (current) current.state.done = true;
      return;
    }
  }

  if (sessionResult.status === 'rejected') {
    log.warn({ tag, err: errStr(sessionResult.reason) }, 'session image pull failed — api will pull on first use');
  }

  emit({ event: 'pulled' });

  // Tell clients we're restarting, then trigger the sidecar.
  emit({ event: 'restarting' });

  // Write the trigger file — the sidecar picks it up, extracts host files,
  // pins the tag, and runs docker compose up -d.
  await fs.writeFile(path.join(triggerDir, 'request'), `${tag}\n`);
  log.info({ tag }, 'update: trigger written, server will restart');

  if (current) current.state.done = true;
}
