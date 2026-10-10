// The deployment — the stack this backend runs in — as ONE object: its
// update, its services' logs and restarts, the machine's load, the token
// report. The SDK builds it (PhantomBackend.deployment) and serves it at
// /api/update and /api/system/*; the Telegram bot's /status, /tokens,
// /restart and the Assistant's docker_logs call it directly — no client of
// this server, inside this server, asks over HTTP for what it can ask here.
//
// The line between the SDK and the app: the SDK knows how to run an update
// (pull, stream, refuse when told to, restart) and never an image name, a
// compose file or a card. The app knows what THIS update is, and hands it
// in as one object, the DeploymentStrategy (config.deployment): which
// images a tag means, how the stack is replaced, when to refuse. Without
// one, updates refuse and everything else still answers.
import os from 'node:os';
import { statfsSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import type Docker from 'dockerode';
import type { Paths } from '../lib/paths.js';
import type { Images } from '../runtime/Images.js';
import type { TokenLog } from '../storage/TokenLog.js';
import { formatTokenReport, reportWindows } from '../storage/tokenReport.js';
import type { Clock } from '../lib/clock.js';
import { startUpdate, subscribe, isRunning, type ApplyFn, type ImageRef } from './updateTask.js';
import type { UpdateEvent } from '@phantom-agent-sdk/client';
import { logger, errStr } from '../lib/log.js';

const log = logger('deployment');

/** A log answer is a page, not a dump: lines asked for, bytes returned. */
export const LOG_MAX_BYTES = 64 * 1024;
export const LOG_MAX_TAIL = 1000;

/** The stack's containers a service name may mean — the label the compose
 *  file sets, never a container name (compose generates those). */
export const LOG_SERVICES = ['api', 'postgres', 'caddy', 'updater', 'autoheal', 'cloudbeaver'] as const;

/** A refusal with a name — the routes map the code to a status. */
export class DeploymentError extends Error {
  constructor(public code: 'logs_unavailable' | 'restart_unavailable' | 'no_such_service' | 'restart_refused' | 'updater_unavailable',
    message: string, public retryable = false) { super(message); }
}

/** What the app knows about its own deployment — the one object it hands
 *  the SDK (config.deployment). */
export interface DeploymentStrategy {
  /** The images a release tag means, this process's own first: its pull
   *  must succeed, the rest are tolerated. */
  images(tag: string): ImageRef[];
  /** Replace the running stack with the tag, once its images are on disk
   *  (sidecarApply for the updater sidecar; anything else is the app's). */
  apply: ApplyFn;
  /** A reason a restart must wait right now (an update's, a service's), or
   *  null. A caller that says restart anyway — a human warned — overrides it. */
  guard?(): string | null;
}

export interface LogsQuery { service?: string; tail?: number; since?: string; grep?: string }

export class Deployment {
  constructor(
    private readonly paths: Paths,
    private readonly tokenLog: TokenLog,
    /** Absent when this server has no docker access: logs and restarts refuse. */
    private readonly docker?: Docker,
    /** The one image puller — the update's pulls go through it so the disk
     *  sweep can never remove an image under a download. */
    private readonly images?: Images,
    /** The app's deployment (config.deployment); absent = updates refuse. */
    private readonly strategy?: DeploymentStrategy,
  ) {}

  /** The strategy's reason to wait, as the refusal a route or a bot sends. */
  private refuseUnless(restartAnyway: boolean | undefined): void {
    const reason = restartAnyway ? null : this.strategy?.guard?.() ?? null;
    if (reason) throw new DeploymentError('restart_refused', `${reason}; send restart_anyway: true to go ahead`, true);
  }

  /** Update the server to a release: pull the images, hand the tag to the
   *  updater sidecar, relay the installer's output — every step through
   *  `onEvent` until the api restarts (or the update fails). Attaches to an
   *  update already in progress. THE guard is the strategy's: a call not
   *  told to restart anyway is refused while it names a reason to wait.
   *  Resolves when the stream ends; `stop` (the caller went away) detaches. */
  update(tag: string, options: { restartAnyway?: boolean }, onEvent: (event: UpdateEvent) => void): { done: Promise<void>; stop(): void } {
    this.refuseUnless(options.restartAnyway);
    const strategy = this.strategy;
    if (!strategy) throw new DeploymentError('updater_unavailable', 'this server has no deployment strategy — it cannot update itself');
    if (!this.images || !this.docker) throw new DeploymentError('updater_unavailable', 'this server has no docker access');
    if (!isRunning()) {
      startUpdate({ images: this.images, docker: this.docker, refs: strategy.images(tag), apply: strategy.apply }, tag);
    }
    let unsub: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
      unsub = subscribe((event) => {
        onEvent(event);
        if (event.event === 'restarting' || event.event === 'error') { unsub?.(); resolve(); }
      });
      if (!unsub) { onEvent({ event: 'error', message: 'no update in progress' }); resolve(); }
    });
    return { done, stop: () => unsub?.() };
  }

  /** The one container for a compose service, or null when absent or stopped
   *  (listContainers is running-only). */
  private async serviceContainer(docker: Docker, service: string): Promise<Docker.Container | null> {
    const list = await docker.listContainers({ filters: { label: [`com.docker.compose.service=${service}`] } });
    return list.length ? docker.getContainer(list[0].Id) : null;
  }

  /** The container's whole log stream as one string (stdout + stderr, demuxed
   *  — over the socket the two arrive in one multiplexed stream). */
  private async readLogs(docker: Docker, container: Docker.Container, opts: { tail: number; since?: string }): Promise<string> {
    const raw = await container.logs({
      stdout: true, stderr: true, follow: false,
      tail: opts.tail, ...(opts.since ? { since: opts.since } : {}),
    });
    const out: Buffer[] = [];
    const sink = new PassThrough();
    sink.on('data', (chunk: Buffer) => out.push(chunk));
    const source = Readable.from(raw);
    docker.modem.demuxStream(source, sink, sink);
    // demuxStream never ends the output streams — end the sink once the source
    // is fully consumed so the 'finish' promise below can resolve.
    source.on('end', () => sink.end());
    await new Promise<void>((resolve, reject) => {
      sink.on('finish', resolve);
      setTimeout(() => { sink.end(); reject(new Error('log read timed out')); }, 8_000);
    });
    return Buffer.concat(out).toString('utf8');
  }

  /** A service's recent log lines, optionally filtered; the newest lines are
   *  the answer, so an over-cap page is cut from the FRONT. */
  async logs(query: LogsQuery = {}): Promise<{ service: string; text: string; truncated?: boolean }> {
    const docker = this.docker;
    if (!docker) throw new DeploymentError('logs_unavailable', 'this server has no docker access');
    const { service = 'api', tail = 100, since, grep } = query;
    const container = await this.serviceContainer(docker, service).catch(() => null);
    if (!container) throw new DeploymentError('no_such_service', `no running container for service "${service}"`);
    let text: string;
    try { text = await this.readLogs(docker, container, { tail, since }); }
    catch (error) {
      log.error({ err: errStr(error), service }, 'log read failed');
      throw new DeploymentError('logs_unavailable', `could not read ${service} logs: ${errStr(error)}`);
    }
    if (grep) {
      let keep: (line: string) => boolean;
      try { const pattern = new RegExp(grep, 'i'); keep = (line) => pattern.test(line); }
      catch { const needle = grep.toLowerCase(); keep = (line) => line.toLowerCase().includes(needle); }
      text = text.split('\n').filter(keep).join('\n');
    }
    const truncated = text.length > LOG_MAX_BYTES;
    if (truncated) text = text.slice(-LOG_MAX_BYTES);
    return { service, text, ...(truncated ? { truncated: true } : {}) };
  }

  /** CPU, load, memory, disk — four lines. Two samples of the per-cpu tick
   *  counters 250 ms apart: the same math top does, no subprocess. */
  async status(): Promise<{ text: string }> {
    const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)}G`;
    const times = () => os.cpus().map((cpu) => ({ ...cpu.times }));
    const a = times();
    await new Promise((wake) => setTimeout(wake, 250));
    const b = times();
    let idle = 0, all = 0;
    for (let i = 0; i < a.length; i++) {
      const totalA = a[i].user + a[i].nice + a[i].sys + a[i].idle + a[i].irq;
      const totalB = b[i].user + b[i].nice + b[i].sys + b[i].idle + b[i].irq;
      idle += b[i].idle - a[i].idle;
      all += totalB - totalA;
    }
    const cpuPct = all > 0 ? Math.round((1 - idle / all) * 100) : 0;
    const load = os.loadavg().map((average) => average.toFixed(2)).join(' ');
    const totalMem = os.totalmem(), freeMem = os.freemem();
    const disk = statfsSync(this.paths.root);
    const diskTotal = disk.blocks * disk.bsize, diskAvail = disk.bavail * disk.bsize;
    return { text: [
      `${cpuPct}% busy · ${a.length} cores`,
      `${load}  (1, 5, 15 min)`,
      `${gib(totalMem - freeMem)} used · ${gib(freeMem)} free · ${gib(totalMem)} total`,
      `${gib(diskTotal - diskAvail)} used · ${gib(diskAvail)} free · ${gib(diskTotal)} total`,
    ].join('\n') };
  }

  /** Restart one compose service. The api restarts ITSELF a beat later, so
   *  the answer is out the door before docker is asked. The strategy's
   *  guard applies as it does to an update: a restart cuts the same work. */
  async restart(service = 'api', options: { restartAnyway?: boolean } = {}): Promise<{ restarting: string; note?: string }> {
    this.refuseUnless(options.restartAnyway);
    const docker = this.docker;
    if (!docker) throw new DeploymentError('restart_unavailable', 'this server has no docker access');
    const all = await docker.listContainers().catch((error) => { log.error({ err: errStr(error) }, 'container list failed'); return null; });
    if (!all) throw new DeploymentError('restart_unavailable', 'docker did not answer');
    const target = all.find((container) => (container.Labels?.['com.docker.compose.service'] ?? '') === service);
    if (!target) {
      const services = [...new Set(all.map((container) => container.Labels?.['com.docker.compose.service']).filter(Boolean))].sort();
      throw new DeploymentError('no_such_service',
        `no running container for service "${service}" — running services: ${services.join(', ') || '(none)'}`);
    }
    const container = docker.getContainer(target.Id);
    if (service === 'api') {
      setTimeout(() => { container.restart().catch((error) => log.warn({ err: errStr(error) }, 'api self-restart failed')); }, 500).unref();
      log.info('api restart requested');
      return { restarting: service, note: 'the api is restarting — back in a few seconds' };
    }
    try { await container.restart(); }
    catch (error) {
      log.error({ err: errStr(error), service }, 'restart failed');
      throw new DeploymentError('restart_unavailable', `could not restart ${service}: ${errStr(error)}`);
    }
    log.info({ service }, 'service restarted');
    return { restarting: service };
  }

  /** The token report: today / 7 days / 30 days, per type × model. "Today"
   *  is the clock's — the builder's midnight, not the container's. */
  async tokenUsage(clock: Clock, now = clock.now()): Promise<{ text: string }> {
    return { text: formatTokenReport(await this.tokenLog.report(reportWindows(clock, now)), clock, now) };
  }
}
