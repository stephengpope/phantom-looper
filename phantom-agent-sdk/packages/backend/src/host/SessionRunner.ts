// SessionRunner — the host process: a box with Docker and a workspace volume
// that connects OUT to a backend and runs its workspaces. The same backend
// image, this entrypoint instead of the API's; no database, no settings, no
// secrets of its own — every job carries what it needs, and the host trusts
// the backend with anything it asks.
//
// It is LocalHost (the primitives, against THIS box's volume and Docker)
// behind a Link: jobs come down the feed, their events go up the relay.
// A dropped link changes nothing about what runs: jobs keep running, their
// events queue, and go when the link is back. Only a job (a kill, a cancel)
// stops anything.
//
// Identity: the key says what the host is (the service role key: shared; a
// user role key: theirs) — by its prefix, before anything is sent. The row's id is persisted beside the volume (host.json) so a
// reconnect — and a restart — is the same host, never a new one. `boot` is
// fresh per process: the backend fails what a dead process was running.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type Docker from 'dockerode';
import { BackendClient, BackendConnection, Link, newId, credentialOf, SERVICE_ROLE_KEY_PREFIX, USER_ROLE_KEY_PREFIX, type Credential, type RetryPolicy } from '@phantom-agent-sdk/client';
import { LocalHost, type LocalHostOptions } from '../runtime/LocalHost.js';
import { Images } from '../runtime/Images.js';
import { makeDocker } from '../runtime/Docker.js';
import { makePaths, type Paths } from '../lib/paths.js';
import * as checkoutPool from '../runtime/CheckoutPool.js';
import { type Job, type JobEvent, type HostHello, type HostLoad, encodeError, fromBase64, toBase64 } from './protocol.js';
import { SDK_VERSION } from '../sdkVersion.js';
import { APP_VERSION, API_IMAGE, SESSION_IMAGE } from '../lib/env.js';
import { startUpdate, subscribe as subscribeUpdate, shutdown as updateShutdown, HELPER_NAME } from '../upgrade/updateTask.js';
import type { UpdateEvent } from '@phantom-agent-sdk/client';
import { logger, errStr } from '../lib/log.js';

const log = logger('session-runner');

/** The host's calls to the backend: local or one hop away. */
const HOST_RETRY: RetryPolicy = { waitsS: [1, 2, 4, 8], budgetMs: 15_000, retryable: (status) => status === 408 || status === 429 || status >= 500 };

export interface SessionRunnerOptions {
  /** The backend's origin, e.g. https://phantom.example.com */
  origin: string;
  /** The service role key (a shared runner) or a user role key (their host). */
  key: string;
  name: string;
  paths: Paths;
  docker: Docker;
  local: LocalHostOptions;
  certificateAuthority?: Buffer;
  /** Where an `update` job drops the release tag for the updater sidecar
   *  (UPDATE_TRIGGER_DIR); absent = no sidecar, updates refuse. */
  updateTriggerDir?: string;
  /** The sidecar's helper container name (HELPER_NAME), when the stack sets one. */
  updateHelperName?: string;
}

export class SessionRunner {
  readonly boot = newId();
  #backend: BackendClient;
  readonly #local: LocalHost;
  readonly #images: Images;
  #link: Link | null = null;
  #id: string | null = null;
  /** Running jobs by id, with the cancel for a stream. A job id seen twice
   *  (a reconnect re-sends what is unfinished) runs once. */
  readonly #running = new Map<string, { cancel?: () => void }>();
  /** Ids finished recently: a re-sent finished job is not run again (its
   *  events were queued and will land). Bounded. */
  readonly #done: string[] = [];
  readonly #doneSet = new Set<string>();
  #stopped = false;

  constructor(private readonly opts: SessionRunnerOptions) {
    // One HTTPS/2 socket for everything, as the cli has: the backend's TLS,
    // its own CA when it runs one (BACKEND_CA). There is no other transport.
    const origin = new URL(opts.origin).origin;
    if (!origin.startsWith('https:')) throw new Error(`BACKEND_URL must be https:// — got ${origin}`);
    this.#connection = new BackendConnection({ origin, ...(opts.certificateAuthority ? { certificateAuthority: opts.certificateAuthority } : {}) });
    // The key says which it is by its prefix; a key with neither is refused
    // here, before it is sent anywhere.
    const credential = credentialOf(opts.key);
    if (!credential) throw new Error(`BACKEND_KEY must be the service role key (${SERVICE_ROLE_KEY_PREFIX}…, a shared runner) or your user role key (${USER_ROLE_KEY_PREFIX}…, your host)`);
    this.#backend = this.#client(credential);
    this.#images = new Images(opts.docker);
    this.#local = new LocalHost(opts.docker, this.#images, opts.paths, opts.local, { id: null, name: opts.name });
  }

  readonly #connection: BackendConnection;
  #client(credential: Credential): BackendClient {
    return new BackendClient({
      url: `${new URL(this.opts.origin).origin}/api`, credential, clientId: `session-runner-${this.boot}`, label: this.opts.name,
      fetch: (input, init) => this.#connection.fetch(input, init), retry: { policy: HOST_RETRY, notice: (text) => log.warn(text) },
    });
  }

  /** The key, proven against the backend. */
  async #resolveCredential(): Promise<void> {
    await this.#backend.call('GET', '/identity/me');
  }

  /** From the environment — the compose service's one way in. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): SessionRunner {
    const origin = env.BACKEND_URL;
    const key = env.BACKEND_KEY;
    if (!origin) throw new Error('BACKEND_URL is not set — the backend this host connects to');
    if (!key) throw new Error('BACKEND_KEY is not set — the service role key (a shared runner) or your user role key (your host)');
    const root = env.WORKSPACE_ROOT_PATH || '/workspaces';
    return new SessionRunner({
      origin, key,
      name: env.HOST_NAME || os.hostname(),
      paths: makePaths(root),
      docker: makeDocker(),
      local: {
        volume: env.WORKSPACE_VOLUME || undefined,
        network: env.AGENT_NETWORK || undefined,
        databaseContainer: env.AGENT_DATABASE_CONTAINER || undefined,
        diskQuota: env.DISK_QUOTA_URL || undefined,
        apiImage: env.API_IMAGE || undefined,
      },
      // A PEM through a .env: its newlines may arrive as the two characters `\n`.
      ...(env.BACKEND_CA ? { certificateAuthority: Buffer.from(env.BACKEND_CA.replace(/\\n/g, '\n')) } : {}),
      ...(env.UPDATE_TRIGGER_DIR ? { updateTriggerDir: env.UPDATE_TRIGGER_DIR } : {}),
      ...(env.HELPER_NAME ? { updateHelperName: env.HELPER_NAME } : {}),
    });
  }

  get id(): string | null { return this.#id; }
  get online(): boolean { return this.#link?.up ?? false; }
  status(): { id: string | null; name: string; online: boolean; running: number } {
    return { id: this.#id, name: this.opts.name, online: this.online, running: this.#running.size };
  }

  /** Boot cleanup, hello, the feed open. Returns once the hello answered;
   *  the feed follows on its own from here. */
  async start(): Promise<void> {
    // The backend may be down, or not yet up, when this box boots: the hello
    // is tried until it answers. A refused key is final — nothing to wait for.
    for (let wait = 2_000; ; wait = Math.min(wait * 2, 30_000)) {
      try { await this.#resolveCredential(); break; }
      catch (error) {
        const status = (error as { status?: number }).status;
        if (status === 401 || status === 403) throw new Error(`the backend refused the key (${status}) — BACKEND_KEY must be the service role key or a user role key`);
        if (this.#stopped) return;
        log.warn({ err: errStr(error), retryInMs: wait }, 'backend unreachable — waiting');
        await new Promise((wake) => setTimeout(wake, wait));
      }
    }
    await checkoutPool.bootCleanup(this.opts.paths);
    await this.#local.retireOldContainers();
    const idFile = path.join(this.opts.paths.root, 'host.json');
    const persisted: { id?: string } = await fs.readFile(idFile, 'utf8').then((text) => JSON.parse(text) as { id?: string }, () => ({}));
    const facts: HostHello['facts'] = {
      dockerVersion: await this.opts.docker.version().then((v) => String((v as { Version?: string }).Version ?? ''), () => undefined),
      arch: os.arch(),
      diskSupport: await this.#local.diskSupport().catch((error) => `probe failed: ${errStr(error)}`),
      sdkVersion: SDK_VERSION,
      version: APP_VERSION,
    };
    const hello: HostHello = { ...(persisted.id ? { id: persisted.id } : {}), name: this.opts.name, boot: this.boot, facts };
    const row = await this.#backend.call<{ id: string; name: string }>('POST', '/session-runners/hello', hello);
    this.#id = row.id;
    if (persisted.id !== row.id) await fs.writeFile(idFile, JSON.stringify({ id: row.id }) + '\n');
    log.info({ host: row.id, name: this.opts.name, boot: this.boot, facts }, 'session runner registered — opening the feed');
    this.#link = new Link(this.#backend, {
      feed: `/session-runners/${row.id}/jobs?boot=${encodeURIComponent(this.boot)}`,
      relay: `/session-runners/${row.id}/jobs/events`,
      onRecord: (record) => { if (record.event !== 'heartbeat') this.#onJob(record as unknown as Job); },
      reset: () => this.#connection.destroy(),
      onStatus: (up) => log.info({ host: row.id }, up ? 'link up' : 'link down — jobs keep running, events queue'),
    });
    this.#link.open();
    // Liveness both ways: the backend heartbeats down the feed; this goes up
    // the relay, so a silently dead socket reads as offline there within 45 s.
    // The beat carries the box's load: what placement orders by.
    this.#heartbeat = setInterval(() => { void this.#load().then((load) => this.#link?.send({ type: 'heartbeat', load })); }, 15_000);
  }
  #heartbeat: ReturnType<typeof setInterval> | null = null;

  /** The box right now. A measure that fails leaves its field out of the
   *  beat rather than holding the beat back: liveness first. */
  async #load(): Promise<HostLoad> {
    const cpu = os.loadavg()[0] / Math.max(1, os.cpus().length);
    const disk = await this.#local.disk().catch(() => ({ freeGB: Infinity, usedPct: 0 }));
    const running = await this.#local.activeWorkspaces().then((ids) => ids.length, () => 0);
    return { cpu, freeGB: disk.freeGB, usedPct: disk.usedPct, running };
  }

  /** Close the link. What runs keeps running; containers stay up. An update
   *  in flight ends its stream first (this restart IS the update), and the
   *  drain carries that last chunk out before the process goes. */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    updateShutdown();
    await this.#link?.drain().catch(() => {});
    this.#link?.close();
    this.#local.stop();
  }

  #report(event: JobEvent): void { this.#link?.send(event); }

  #finish(id: string): void {
    this.#running.delete(id);
    this.#doneSet.add(id); this.#done.push(id);
    while (this.#done.length > 5_000) this.#doneSet.delete(this.#done.shift()!);
  }

  #onJob(job: Job): void {
    if (!job || typeof job.id !== 'string') return;
    if (job.type === 'cancel') { this.#running.get(job.job)?.cancel?.(); return; }
    if (job.type === 'unwatch') { this.#local.unwatch(job.workspaceId); return; }
    if (this.#running.has(job.id) || this.#doneSet.has(job.id)) return;
    const entry: { cancel?: () => void } = {};
    this.#running.set(job.id, entry);
    void this.#run(job, entry)
      .catch((error) => { log.warn({ job: job.id, type: job.type, err: errStr(error) }, 'job failed'); this.#report({ job: job.id, type: 'error', ...encodeError(error) }); })
      .finally(() => this.#finish(job.id));
  }

  async #run(job: Job, entry: { cancel?: () => void }): Promise<void> {
    const local = this.#local;
    const result = (value: unknown) => this.#report({ job: job.id, type: 'result', value });
    switch (job.type) {
      case 'checkout': return result(await local.checkout(job.workspaceId, job.projectId, job.branch, job.auth));
      case 'removeFiles': await local.removeFiles(job.workspaceId); return result(null);
      case 'git': return result(await local.repo(job.workspaceId).git(job.args, job.auth));
      case 'exists': return result(await local.repo(job.workspaceId).exists(job.rel));
      case 'read': { const got = await local.files(job.workspaceId).read(job.rel); return result(got === null ? null : toBase64(got)); }
      case 'write': await local.files(job.workspaceId).write(job.rel, fromBase64(job.data)); return result(null);
      case 'tail': return result(toBase64(await local.files(job.workspaceId).tail(job.rel, job.bytes)));
      case 'stat': return result(await local.files(job.workspaceId).stat(job.rel));
      case 'list': return result(await local.files(job.workspaceId).list(job.rel));
      case 'mkdir': await local.files(job.workspaceId).mkdir(job.rel); return result(null);
      case 'rm': await local.files(job.workspaceId).rm(job.rel); return result(null);
      case 'realFile': return result(await local.files(job.workspaceId).realFile(job.rel));
      case 'containerUp': return result(await local.containerUp(job.workspaceId, job.plan));
      case 'containerRemove': await local.containerRemove(job.workspaceId); return result(null);
      case 'containerState': return result(await local.containerState(job.workspaceId));
      case 'activeWorkspaces': return result(await local.activeWorkspaces());
      case 'disk': return result(await local.disk());
      case 'diskSupport': return result(await local.diskSupport());
      case 'exec': {
        const ran = await local.sandbox(job.workspaceId).run(job.argv, {
          cwd: job.cwd, maxBytes: job.maxBytes, timeoutMs: job.timeoutMs,
          ...(job.stdin !== undefined ? { stdin: fromBase64(job.stdin) } : {}),
        });
        return result({ stdout: toBase64(ran.stdout), stderr: toBase64(ran.stderr), exitCode: ran.exitCode });
      }
      case 'execStream': return this.#pipe(job.id, entry, local.sandbox(job.workspaceId).runStream(job.argv, { cwd: job.cwd, timeoutMs: job.timeoutMs }));
      case 'detach': return this.#pipe(job.id, entry, local.detach(job.workspaceId, job.taskId, job.argv, job.cwd, job.sidfile));
      case 'update': return this.#pipe(job.id, entry, this.#update(job.tag, job.sessionImage));
      case 'watch': {
        // A standing order: chunks for as long as the watch stands; no end.
        local.watch(job.workspaceId, () => this.#report({ job: job.id, type: 'chunk', value: { changed: true } }));
        this.#running.delete(job.id);
        return;
      }
      default: throw new Error(`unknown job type ${(job as { type: string }).type}`);
    }
  }

  /** The upgrade, as the server does its own (upgrade/updateTask.ts): pull
   *  the images, write the trigger, relay the installer's lines — each an
   *  UpdateEvent up the relay — until `restarting` (the sidecar recreated
   *  this container; stop() said so) or `error`. A second update while one
   *  runs attaches to it. */
  async *#update(tag: string, sessionImage: string): AsyncGenerator<UpdateEvent> {
    if (!this.opts.updateTriggerDir) throw new Error('this runner has no updater sidecar (UPDATE_TRIGGER_DIR unset) — bring its compose file up to date: phantom-cli runner start, or copy session-runner/ out of the image again');
    const queue: UpdateEvent[] = [];
    let wake: (() => void) | null = null;
    let over = false;
    const listener = (event: UpdateEvent) => {
      if (event.event === 'heartbeat') return;
      queue.push(event);
      if (event.event === 'restarting' || event.event === 'error') over = true;
      wake?.();
    };
    startUpdate({ images: this.#images, docker: this.opts.docker, triggerDir: this.opts.updateTriggerDir,
      apiImage: this.opts.local.apiImage ?? API_IMAGE, sessionImage: sessionImage || SESSION_IMAGE,
      ...(this.opts.updateHelperName ? { helperName: this.opts.updateHelperName } : { helperName: HELPER_NAME }) }, tag);
    const unsubscribe = subscribeUpdate(listener);
    if (!unsubscribe) throw new Error('no update in progress');
    try {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (over) return;
        await new Promise<void>((resume) => { wake = resume; });
        wake = null;
      }
    } finally { unsubscribe(); }
  }

  /** A stream's records up as chunks, then `end`. A cancel ends the
   *  iteration (the generator's own teardown stops the exec). */
  async #pipe(id: string, entry: { cancel?: () => void }, records: AsyncIterable<unknown>): Promise<void> {
    const iterator = records[Symbol.asyncIterator]();
    let cancelled = false;
    entry.cancel = () => { cancelled = true; void iterator.return?.(); };
    for (;;) {
      const next = await iterator.next();
      if (next.done || cancelled) break;
      this.#report({ job: id, type: 'chunk', value: next.value });
    }
    if (!cancelled) this.#report({ job: id, type: 'end' });
  }
}
