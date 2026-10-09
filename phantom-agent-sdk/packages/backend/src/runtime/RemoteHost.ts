// RemoteHost — a session runner as the backend sees it: every primitive of
// WorkspaceHost sent as a job down the host's feed, its answer read off the
// relay. A proxy; nothing runs here.
//
// OFFLINE IS A WAIT, NEVER A FAILURE. A job for a host whose link is down is
// queued and goes the moment the link is back; its promise stays pending.
// The one thing that fails pending jobs is the host coming back as a NEW
// PROCESS (a different boot id): what it was running died with it, and the
// callers hear `host_restarted` — retryable, and true.
//
// Background work that must not hang on a closed laptop checks `online`
// first (the syncs, the sweeps). A person's tool call waits, and the person
// sees why on the feed.
import { newId } from '@phantom-agent-sdk/client';
import type { ContainerPlan, ContainerState, DetachEvent, FileType, FileStat, Repo, WorkspaceFiles, WorkspaceHost } from './WorkspaceHost.js';
import { Sandbox, type Exec, type RunOpts, type RunResult, type StreamRecord } from './Sandbox.js';
import type { GitAuth } from '../git/Git.js';
import type { UpdateEvent } from '@phantom-agent-sdk/client';
import { type HostLoad, type Job, type JobBody, type JobEvent, decodeError, encodeRunOpts, fromBase64, toBase64 } from '../host/protocol.js';
import { logger } from '../lib/log.js';

const log = logger('remote-host');

interface Pending {
  job: Job;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** A streaming job's consumer; absent for a one-answer job. */
  onChunk?: (value: unknown) => void;
}

export class RemoteHost implements WorkspaceHost {
  #writer: ((job: Job) => void) | null = null;
  #boot: string | null = null;
  readonly #pending = new Map<string, Pending>();
  /** Watches by workspace: re-sent whole on every (re)connect — a watch is a
   *  standing order, not a job with an end. */
  readonly #watches = new Map<string, { job: Job; onChange: () => void }>();

  constructor(readonly id: string, public name: string) {}

  get online(): boolean { return this.#writer !== null; }
  /** Jobs sent and not yet answered — what an update's restart would cut. */
  get inFlight(): number { return this.#pending.size; }

  /** The box's load as of its last heartbeat; null before the first one. */
  load: HostLoad | null = null;

  // ── the link ──────────────────────────────────────────────────────────

  /** The host opened its feed. Everything unfinished goes down it again
   *  (the host runs an id once) — unless this is a different process, in
   *  which case what was in flight is gone and its callers are told. */
  attach(boot: string, writer: (job: Job) => void): void {
    if (this.#boot !== null && this.#boot !== boot) {
      const gone = [...this.#pending.values()];
      this.#pending.clear();
      log.warn({ host: this.id, jobs: gone.length }, 'session runner restarted — its jobs in flight are gone');
      for (const pending of gone) pending.reject(Object.assign(new Error(`session runner ${this.name} restarted — the job did not finish`), { code: 'host_restarted', retryable: true }));
    }
    this.#boot = boot;
    this.#writer = writer;
    for (const pending of this.#pending.values()) writer(pending.job);
    for (const watch of this.#watches.values()) writer(watch.job);
  }

  /** The feed closed. Pending jobs stay pending; the next attach re-sends them. */
  unlink(writer: (job: Job) => void): void {
    if (this.#writer === writer) this.#writer = null;
  }

  /** Events off the relay, in order. */
  deliver(events: JobEvent[]): void {
    for (const event of events) {
      if (event.type === 'heartbeat') { if (event.load) this.load = event.load; continue; }
      if (event.type === 'chunk' && this.#watches.size) {
        // A watch's chunk: routed by the standing order's job id.
        const watch = [...this.#watches.values()].find((one) => one.job.id === event.job);
        if (watch) { watch.onChange(); continue; }
      }
      const pending = this.#pending.get(event.job);
      if (!pending) continue;   // finished already (a re-sent job answered twice), or cancelled
      switch (event.type) {
        case 'result': this.#pending.delete(event.job); pending.resolve(event.value); break;
        case 'error': this.#pending.delete(event.job); pending.reject(decodeError(event)); break;
        case 'chunk': pending.onChunk?.(event.value); break;
        case 'end': this.#pending.delete(event.job); pending.resolve(undefined); break;
      }
    }
  }

  #send(job: Job): void { this.#writer?.(job); }

  /** One job, one answer. Waits out a closed link. */
  #call<T>(job: JobBody): Promise<T> {
    const id = newId();
    const full = { id, ...job };
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { job: full, resolve: resolve as (value: unknown) => void, reject });
      this.#send(full);
    });
  }

  /** A streaming job: chunks as they come, until `end` (or an error). A
   *  consumer that stops early cancels the job on the host. */
  async *#stream<T>(job: JobBody): AsyncGenerator<T> {
    const id = newId();
    const full = { id, ...job };
    const chunks: T[] = [];
    // Written from the deliver callbacks, read by the loop below: a holder,
    // so the loop sees what the callbacks wrote.
    const state: { done: boolean; failed: Error | null } = { done: false, failed: null };
    let wake: (() => void) | null = null;
    const finished = new Promise<void>((resolve) => {
      this.#pending.set(id, {
        job: full,
        onChunk: (value) => { chunks.push(value as T); wake?.(); },
        resolve: () => { state.done = true; wake?.(); resolve(); },
        reject: (error) => { state.failed = error; state.done = true; wake?.(); resolve(); },
      });
    });
    this.#send(full);
    try {
      for (;;) {
        while (chunks.length) yield chunks.shift()!;
        if (state.done) break;
        await new Promise<void>((resume) => { wake = resume; });
        wake = null;
      }
      if (state.failed) throw state.failed;
    } finally {
      if (!state.done) {
        this.#pending.delete(id);
        this.#send({ id: newId(), type: 'cancel', job: id });
      }
      void finished;
    }
  }

  // ── the checkout ──────────────────────────────────────────────────────

  checkout(workspaceId: string, projectId: string, branch: string, auth: GitAuth): Promise<'claimed' | 'cloned'> {
    return this.#call({ type: 'checkout', workspaceId, projectId, branch, auth });
  }
  removeFiles(workspaceId: string): Promise<void> { return this.#call({ type: 'removeFiles', workspaceId }); }

  repo(workspaceId: string): Repo {
    return {
      git: (args, auth) => this.#call({ type: 'git', workspaceId, args, ...(auth ? { auth } : {}) }),
      exists: (rel) => this.#call({ type: 'exists', workspaceId, rel }),
    };
  }

  files(workspaceId: string): WorkspaceFiles {
    const call = <T>(job: JobBody) => this.#call<T>(job);
    return {
      read: async (rel) => { const got = await call<string | null>({ type: 'read', workspaceId, rel }); return got === null ? null : fromBase64(got); },
      write: (rel, data) => call({ type: 'write', workspaceId, rel, data: toBase64(data) }),
      tail: async (rel, bytes) => fromBase64(await call<string>({ type: 'tail', workspaceId, rel, bytes })),
      stat: (rel) => call<FileStat | null>({ type: 'stat', workspaceId, rel }),
      list: (rel) => call<Array<{ name: string; type: FileType }> | null>({ type: 'list', workspaceId, rel }),
      mkdir: (rel) => call({ type: 'mkdir', workspaceId, rel }),
      rm: (rel) => call({ type: 'rm', workspaceId, rel }),
      realFile: (rel) => call<string | null>({ type: 'realFile', workspaceId, rel }),
    };
  }

  // ── the container ─────────────────────────────────────────────────────

  containerUp(workspaceId: string, plan: ContainerPlan): Promise<{ created: boolean }> {
    return this.#call({ type: 'containerUp', workspaceId, plan });
  }
  containerRemove(workspaceId: string): Promise<void> { return this.#call({ type: 'containerRemove', workspaceId }); }
  containerState(workspaceId: string): Promise<ContainerState> { return this.#call({ type: 'containerState', workspaceId }); }

  /** Unknown while offline reads as none: the reaper and the refresh skip
   *  what they cannot see, and ask again next tick. */
  activeWorkspaces(): Promise<string[]> {
    if (!this.online) return Promise.resolve([]);
    return this.#call({ type: 'activeWorkspaces' });
  }

  sandbox(workspaceId: string): Sandbox { return new Sandbox(new RemoteExec(this, workspaceId)); }

  detach(workspaceId: string, taskId: string, argv: string[], cwd: string | undefined, sidfile: string): AsyncIterable<DetachEvent> {
    return this.#stream<DetachEvent>({ type: 'detach', workspaceId, taskId, argv, ...(cwd !== undefined ? { cwd } : {}), sidfile });
  }

  /** The exec primitives, for RemoteExec. */
  exec(workspaceId: string, argv: string[], opts: RunOpts): Promise<RunResult> {
    return this.#call<{ stdout: string; stderr: string; exitCode: number }>({ type: 'exec', workspaceId, argv, ...encodeRunOpts(opts) })
      .then((ran) => ({ stdout: fromBase64(ran.stdout), stderr: fromBase64(ran.stderr), exitCode: ran.exitCode }));
  }
  execStream(workspaceId: string, argv: string[], opts: { cwd?: string; timeoutMs?: number }): AsyncGenerator<StreamRecord> {
    return this.#stream<StreamRecord>({ type: 'execStream', workspaceId, argv, ...opts });
  }

  // ── the watcher ───────────────────────────────────────────────────────

  watch(workspaceId: string, onChange: () => void): void {
    const known = this.#watches.get(workspaceId);
    if (known) { known.onChange = onChange; return; }
    const job: Job = { id: newId(), type: 'watch', workspaceId };
    this.#watches.set(workspaceId, { job, onChange });
    this.#send(job);
  }
  unwatch(workspaceId: string): void {
    if (!this.#watches.delete(workspaceId)) return;
    this.#send({ id: newId(), type: 'unwatch', workspaceId });
  }

  // ── the box ───────────────────────────────────────────────────────────

  disk(): Promise<{ usedPct: number; freeGB: number }> { return this.#call({ type: 'disk' }); }
  diskSupport(): Promise<string | null> { return this.#call({ type: 'diskSupport' }); }
  /** Upgrade the runner to `tag`: its progress as UpdateEvents until it
   *  restarts (the stream ends, or the new boot fails it `host_restarted`,
   *  which the caller reads as the same thing) or fails. */
  update(tag: string, sessionImage: string): AsyncGenerator<UpdateEvent> {
    return this.#stream<UpdateEvent>({ type: 'update', tag, sessionImage });
  }
}

/** Exec over jobs — the Sandbox's rules hold unchanged on top. */
class RemoteExec implements Exec {
  constructor(private readonly host: RemoteHost, private readonly workspaceId: string) {}
  runOnce(argv: string[], opts: RunOpts): Promise<RunResult> { return this.host.exec(this.workspaceId, argv, opts); }
  runStream(argv: string[], opts: { cwd?: string; timeoutMs?: number }): AsyncGenerator<StreamRecord> { return this.host.execStream(this.workspaceId, argv, opts); }
}
