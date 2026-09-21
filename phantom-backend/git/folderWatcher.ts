// FolderWatcher — "tell me when a file in this folder changes", backed by a
// child process running @parcel/watcher (watcherChild.ts says why). This is
// the parent side: it forks the child, forwards every watch to it, and when
// the child exits for ANY reason forks a new one and replays every watch.
// Each replayed watch also fires its callback once: a change could have
// landed in the gap, and the caller's real gate (hasWorkToLand, one
// `git status`) makes a false positive free while a missed change is
// stranded work.
import { fork, type ChildProcess } from 'node:child_process';
import { logger, errStr } from '../log.js';

const log = logger('folder-watcher');

const CHILD = new URL('./watcherChild.js', import.meta.url);

interface Watch { dir: string; onChange: () => void }

export class FolderWatcher {
  private watches = new Map<string, Watch>();
  private child: ChildProcess | undefined;
  private stopped = false;

  /** Start watching `dir` under `id`; `onChange` fires on any file change
   *  (and once on every child restart). A second call for the same id
   *  replaces the callback. */
  watch(id: string, dir: string, onChange: () => void): void {
    const known = this.watches.has(id);
    this.watches.set(id, { dir, onChange });
    if (!known) this.send({ op: 'watch', id, dir });
  }

  unwatch(id: string): void {
    if (this.watches.delete(id)) this.send({ op: 'unwatch', id });
  }

  stop(): void {
    this.stopped = true;
    this.watches.clear();
    this.child?.kill('SIGKILL');
    this.child = undefined;
  }

  private send(m: object): void {
    if (this.stopped) return;
    // No child yet: spawning replays the map, which already holds this change.
    if (!this.child) { this.spawn(); return; }
    this.child.send(m);
  }

  private spawn(): void {
    const child = fork(CHILD, [], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    this.child = child;
    log.info({ pid: child.pid, watches: this.watches.size }, 'watcher child started');
    child.on('message', (m: { op: string; id: string }) => {
      if (m.op === 'changed') this.watches.get(m.id)?.onChange();
    });
    child.on('error', (e) => log.error({ pid: child.pid, err: errStr(e) }, 'watcher child error'));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return; // stop() or an older generation
      this.child = undefined;
      if (this.stopped) return;
      log.warn({ pid: child.pid, code, signal, watches: this.watches.size }, 'watcher child exited — restarting');
      this.spawn();
      for (const w of this.watches.values()) w.onChange();
    });
    // Replay: every watch this process holds, to the new child.
    for (const [id, w] of this.watches) child.send({ op: 'watch', id, dir: w.dir });
  }
}
