// The server's own health and housekeeping as ONE object: the compose
// stack's logs and restarts, the machine's load, the token report. The
// /system routes are thin over it, and the Telegram bot's /status, /tokens,
// /restart and the Assistant's docker_logs call it directly — no client of
// this server, inside this server, asks over HTTP for what it can ask here.
import os from 'node:os';
import { statfsSync } from 'node:fs';
import { PassThrough, Readable } from 'node:stream';
import type Docker from 'dockerode';
import type { Paths } from './pool/paths.js';
import type { LogTokens } from './logTokens.js';
import { formatTokenReport, reportWindows } from './tokenReport.js';
import { startUpdate, subscribe, isRunning, type UpdateEvent } from './api/updateTask.js';
import { API_IMAGE } from './env.js';
import { logger, errStr } from './log.js';

const log = logger('system');

/** A log answer is a page, not a dump: lines asked for, bytes returned. */
export const LOG_MAX_BYTES = 64 * 1024;
export const LOG_MAX_TAIL = 1000;

/** The stack's containers a service name may mean — the label the compose
 *  file sets, never a container name (compose generates those). */
export const LOG_SERVICES = ['api', 'postgres', 'caddy', 'updater', 'autoheal'] as const;

/** A refusal with a name — the routes map the code to a status. */
export class SystemError extends Error {
  constructor(public code: 'logs_unavailable' | 'restart_unavailable' | 'no_such_service' | 'loops_running' | 'updater_unavailable',
    message: string, public retryable = false) { super(message); }
}

export interface LogsQuery { service?: string; tail?: number; since?: string; grep?: string }

export class System {
  constructor(
    private readonly paths: Paths,
    private readonly logTokens: LogTokens,
    /** Absent when this server has no docker access: logs and restarts refuse. */
    private readonly docker?: Docker,
    /** Where POST /update drops a release tag for the updater sidecar; absent =
     *  no sidecar, updates refuse. */
    private readonly updateTriggerDir?: string,
    /** Loop rounds in flight — what an update's restart would cut. */
    private readonly loopsRunning: () => number = () => 0,
  ) {}

  /** Update the server to a release: hand the tag to the updater sidecar and
   *  report progress through `onEvent` until the api restarts (or the update
   *  fails). Attaches to an update already in progress. THE guard: a restart
   *  interrupts every loop round in flight (they resume after boot), so a
   *  call not told to restart anyway is refused while any card is mid-round.
   *  Resolves when the stream ends; `stop` (the caller went away) detaches. */
  update(tag: string, o: { restartAnyway?: boolean }, onEvent: (e: UpdateEvent) => void): { done: Promise<void>; stop(): void } {
    const loops = this.loopsRunning();
    if (loops > 0 && !o.restartAnyway) {
      throw new SystemError('loops_running',
        `${loops === 1 ? '1 card has' : `${loops} cards have`} a round in flight — updating now would interrupt ${loops === 1 ? 'it' : 'them'} (${loops === 1 ? 'it resumes' : 'they resume'} after the restart); send restart_anyway: true to update anyway`, true);
    }
    if (!this.updateTriggerDir) throw new SystemError('updater_unavailable', 'this server has no updater sidecar (UPDATE_TRIGGER_DIR unset) — re-run install.sh once');
    if (!this.docker) throw new SystemError('updater_unavailable', 'this server has no docker access');
    if (!isRunning()) startUpdate(this.docker, tag, this.updateTriggerDir, API_IMAGE, 'ghcr.io/stephengpope/phantom-backend-session');
    let unsub: (() => void) | null = null;
    const done = new Promise<void>((resolve) => {
      unsub = subscribe((e) => {
        onEvent(e);
        if (e.event === 'restarting' || e.event === 'error') { unsub?.(); resolve(); }
      });
      if (!unsub) { onEvent({ event: 'error', message: 'no update in progress' } as UpdateEvent); resolve(); }
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
    sink.on('data', (d: Buffer) => out.push(d));
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
  async logs(q: LogsQuery = {}): Promise<{ service: string; text: string; truncated?: boolean }> {
    const docker = this.docker;
    if (!docker) throw new SystemError('logs_unavailable', 'this server has no docker access');
    const { service = 'api', tail = 100, since, grep } = q;
    const container = await this.serviceContainer(docker, service).catch(() => null);
    if (!container) throw new SystemError('no_such_service', `no running container for service "${service}"`);
    let text: string;
    try { text = await this.readLogs(docker, container, { tail, since }); }
    catch (e) {
      log.error({ err: errStr(e), service }, 'log read failed');
      throw new SystemError('logs_unavailable', `could not read ${service} logs: ${errStr(e)}`);
    }
    if (grep) {
      let keep: (line: string) => boolean;
      try { const re = new RegExp(grep, 'i'); keep = (line) => re.test(line); }
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
    const times = () => os.cpus().map((c) => ({ ...c.times }));
    const a = times();
    await new Promise((r) => setTimeout(r, 250));
    const b = times();
    let idle = 0, all = 0;
    for (let i = 0; i < a.length; i++) {
      const totalA = a[i].user + a[i].nice + a[i].sys + a[i].idle + a[i].irq;
      const totalB = b[i].user + b[i].nice + b[i].sys + b[i].idle + b[i].irq;
      idle += b[i].idle - a[i].idle;
      all += totalB - totalA;
    }
    const cpuPct = all > 0 ? Math.round((1 - idle / all) * 100) : 0;
    const load = os.loadavg().map((n) => n.toFixed(2)).join(' ');
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
   *  the answer is out the door before docker is asked. */
  async restart(service = 'api'): Promise<{ restarting: string; note?: string }> {
    const docker = this.docker;
    if (!docker) throw new SystemError('restart_unavailable', 'this server has no docker access');
    const all = await docker.listContainers().catch((e) => { log.error({ err: errStr(e) }, 'container list failed'); return null; });
    if (!all) throw new SystemError('restart_unavailable', 'docker did not answer');
    const target = all.find((c) => (c.Labels?.['com.docker.compose.service'] ?? '') === service);
    if (!target) {
      const services = [...new Set(all.map((c) => c.Labels?.['com.docker.compose.service']).filter(Boolean))].sort();
      throw new SystemError('no_such_service',
        `no running container for service "${service}" — running services: ${services.join(', ') || '(none)'}`);
    }
    const container = docker.getContainer(target.Id);
    if (service === 'api') {
      setTimeout(() => { container.restart().catch((e) => log.warn({ err: errStr(e) }, 'api self-restart failed')); }, 500).unref();
      log.info('api restart requested');
      return { restarting: service, note: 'the api is restarting — back in a few seconds' };
    }
    try { await container.restart(); }
    catch (e) {
      log.error({ err: errStr(e), service }, 'restart failed');
      throw new SystemError('restart_unavailable', `could not restart ${service}: ${errStr(e)}`);
    }
    log.info({ service }, 'service restarted');
    return { restarting: service };
  }

  /** The token report: today / 7 days / 30 days, per kind × model. */
  async tokenUsage(now = new Date()): Promise<{ text: string }> {
    return { text: formatTokenReport(await this.logTokens.report(reportWindows(now)), now) };
  }
}
