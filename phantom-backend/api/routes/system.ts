// Server-level operations. Today: the remote upgrade.
//
// POST /update {tag} drops the requested release tag where the updater
// sidecar polls for it (UPDATE_TRIGGER_DIR, a volume shared with the `updater`
// compose service). The sidecar pulls that tag's images, refreshes the host
// files out of the api image, pins the tag in .env and recreates the stack —
// see updater/. This process never touches docker for that: it only sees the
// socket proxy, which refuses everything compose needs, and that is the point
// (the thing holding the real socket has no network surface). The route
// returns as soon as the trigger is written; the restart that follows is the
// observable result (GET /health's version changes).
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import { statfsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type Docker from 'dockerode';
import type { AppCtx } from '../app.js';
import { err, ok } from '../app.js';
import { logger, errStr } from '../../log.js';
import { catalog, modelsFor } from '../../models.js';
import { PROVIDERS, isProvider } from '../../../core/llm/createAgent.js';

const log = logger('system');

/** A log answer is a page, not a dump: lines asked for, bytes returned. */
const LOG_MAX_BYTES = 64 * 1024;
const LOG_MAX_TAIL = 1000;

/** The stack's containers a service name may mean — the label the compose
 *  file sets, never a container name (compose generates those). */
const LOG_SERVICES = ['api', 'postgres', 'caddy', 'updater', 'autoheal'] as const;

/** The one container for a compose service, or null when absent or stopped
 *  (listContainers is running-only). */
async function serviceContainer(docker: Docker, service: string): Promise<Docker.Container | null> {
  const list = await docker.listContainers({ filters: { label: [`com.docker.compose.service=${service}`] } });
  return list.length ? docker.getContainer(list[0].Id) : null;
}

/** The container's whole log stream as one string (stdout + stderr, demuxed
 *  — over the socket the two arrive in one multiplexed stream). */
async function readLogs(docker: Docker, container: Docker.Container,
  opts: { tail: number; since?: string }): Promise<string> {
  // follow:false answers with the whole multiplexed payload as ONE buffer;
  // re-stream it so the modem can split stdout/stderr frames off it.
  const raw = await container.logs({
    stdout: true, stderr: true, follow: false,
    tail: opts.tail, ...(opts.since ? { since: opts.since } : {}),
  });
  const out: Buffer[] = [];
  const sink = new PassThrough();
  sink.on('data', (d: Buffer) => out.push(d));
  docker.modem.demuxStream(Readable.from(raw), sink, sink);
  await new Promise<void>((resolveP) => sink.on('finish', () => resolveP()));
  return Buffer.concat(out).toString('utf8');
}

export const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

export function systemRoutes(app: FastifyInstance, ctx: AppCtx) {
  // The model catalog, served by the server so every client and the `model`
  // default read ONE list (models.ts: models.dev, an hour in memory, the
  // release's snapshot when it cannot be reached).
  app.get<{ Querystring: { provider?: string } }>('/models', {
    schema: {
      tags: ['meta'],
      summary: 'The model catalog for one provider',
      description: 'Models the catalog (models.dev) lists for a provider, newest first — each with `id`, `name`, ' +
        '`reasoning` and `releaseDate`. The first is what an unset `model` setting resolves to. `source` says ' +
        'whether the list is live or this release\'s snapshot. openai-compatible has no catalog and returns []; ' +
        'the list is a convenience, never a fence — any model id may be stored.',
      querystring: { type: 'object', required: ['provider'], properties: {
        provider: { type: 'string', enum: [...PROVIDERS] } } },
    },
  }, async (req, reply) => {
    const p = req.query.provider ?? '';
    if (!isProvider(p)) return reply.code(400).send(err('invalid_args', `provider must be one of: ${PROVIDERS.join(', ')}`));
    return ok({ provider: p, source: catalog().source, models: modelsFor(p) });
  });

  app.post('/update', {
    schema: {
      tags: ['meta'],
      summary: 'Upgrade this server to a release',
      description: 'Hands a release tag to the updater sidecar, which pulls that version\'s images, ' +
        'refreshes the deploy files on the host from the image, and recreates the stack. Returns as soon as ' +
        'the request is handed over — the upgrade itself takes a minute or two, during which the API ' +
        'restarts (in-flight bash commands are cut off; sessions resume on their next call). ' +
        'Watch GET /health `version` change. While a card has a loop round in flight the route refuses ' +
        '(409 `loops_running`) unless the caller passes `restart_anyway` — the guard lives HERE so no ' +
        'client can kill running cards by forgetting to check. `updater_unavailable` (503) means this ' +
        'server was started without the sidecar (a dev `docker compose up`, or an install older than ' +
        'it): re-run install.sh once.',
      body: {
        type: 'object', required: ['tag'], additionalProperties: false,
        properties: {
          tag: { type: 'string', pattern: RELEASE_TAG.source, description: 'Release tag, e.g. v0.2.0 (no prereleases)' },
          restart_anyway: { type: 'boolean', description: 'Update even with loop rounds in flight — they are cut off and their cards blocked. Only a caller whose human was warned should send this.' },
        },
      },
    },
  }, async (req, reply) => {
    const { tag, restart_anyway: restartAnyway } = req.body as { tag: string; restart_anyway?: boolean };
    // THE guard: a restart cuts every loop round in flight and blocks those
    // cards, so a request that has not been explicitly told to restart anyway
    // is refused while any card is mid-round.
    const loops = ctx.looper?.runningCount() ?? 0;
    if (loops > 0 && !restartAnyway) {
      return reply.code(409).send(err('loops_running',
        `${loops === 1 ? '1 card has' : `${loops} cards have`} a round in flight — updating now would stop ${loops === 1 ? 'it' : 'them'} and block the ${loops === 1 ? 'card' : 'cards'}; send restart_anyway: true to update anyway`, true));
    }
    if (!ctx.updateTriggerDir) {
      return reply.code(503).send(err('updater_unavailable', 'this server has no updater sidecar (UPDATE_TRIGGER_DIR unset) — re-run install.sh once'));
    }
    try {
      await fs.writeFile(path.join(ctx.updateTriggerDir, 'request'), `${tag}\n`);
    } catch (e) {
      log.error({ err: errStr(e), tag }, 'update trigger failed');
      return reply.code(503).send(err('updater_unavailable', `could not hand the request to the updater: ${errStr(e)}`));
    }
    log.info({ tag }, 'update requested');
    return ok({ tag, requested: true });
  });

  app.post<{ Body: { service?: string; tail?: number; since?: string; grep?: string } }>('/system/logs', {
    schema: {
      tags: ['meta'],
      summary: 'Read a server container\'s logs',
      description: '`docker logs` for one of the stack\'s containers (api, postgres, caddy, updater, ' +
        'autoheal — default api), narrowed server-side: `tail` lines (default 100, max 1000), `since` ' +
        '(a duration like "30m" / "2h"), `grep` (a regex; filters WITHIN the tail, so raise tail for a ' +
        'wider search). Answers as `text`, newest last, capped at 64 KB (`truncated`). This backs the ' +
        'assistant\'s docker_logs tool.',
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          service: { type: 'string', enum: [...LOG_SERVICES], description: 'compose service (default api)' },
          tail: { type: 'integer', minimum: 1, maximum: LOG_MAX_TAIL, description: 'last N lines (default 100)' },
          since: { type: 'string', maxLength: 64, pattern: '^[0-9smhd]+$', description: 'duration, e.g. "30m"' },
          grep: { type: 'string', maxLength: 500, description: 'regex — keep only matching lines' },
        },
      },
    },
  }, async (req, reply) => {
    const docker = ctx.fs?.docker;
    if (!docker) return reply.code(503).send(err('logs_unavailable', 'this server has no docker access'));
    const { service = 'api', tail = 100, since, grep } = req.body ?? {};
    const container = await serviceContainer(docker, service).catch(() => null);
    if (!container) {
      return reply.code(404).send(err('no_such_service', `no running container for service "${service}"`));
    }
    let text: string;
    try {
      text = await readLogs(docker, container, { tail, since });
    } catch (e) {
      log.error({ err: errStr(e), service }, 'log read failed');
      return reply.code(503).send(err('logs_unavailable', `could not read ${service} logs: ${errStr(e)}`));
    }
    if (grep) {
      let keep: (line: string) => boolean;
      try {
        const re = new RegExp(grep, 'i');
        keep = (line) => re.test(line);
      } catch {
        const needle = grep.toLowerCase();  // not a regex — a plain substring
        keep = (line) => line.toLowerCase().includes(needle);
      }
      text = text.split('\n').filter(keep).join('\n');
    }
    // The newest lines are the answer: cut from the FRONT when over the cap.
    const truncated = text.length > LOG_MAX_BYTES;
    if (truncated) text = text.slice(-LOG_MAX_BYTES);
    return ok({ service, text, ...(truncated ? { truncated: true } : {}) });
  });

  app.get('/system/status', {
    schema: {
      tags: ['meta'],
      summary: 'Server status — cpu, load, memory, disk',
      description: 'Read straight from the kernel (no docker, no mounts): in a container /proc shows the ' +
        'HOST\'s cpu, load and memory, and the workspaces volume sits on the host\'s root filesystem, so ' +
        'statfs on it is the disk docker\'s data lives on. Answers as preformatted `text` — render it ' +
        'as-is (the cli\'s /cpu and telegram\'s /cpu both do).',
    },
  }, async () => {
    const gib = (bytes: number) => `${(bytes / 2 ** 30).toFixed(1)}G`;
    // Two samples of the per-cpu tick counters, 250 ms apart — the same math
    // top does, no subprocess.
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
    const disk = statfsSync(ctx.paths.root);
    const diskTotal = disk.blocks * disk.bsize, diskAvail = disk.bavail * disk.bsize;
    const text = [
      '== cpu ==',
      `${cpuPct}% busy · ${a.length} cores`,
      '',
      '== load ==',
      `${load}  (1, 5, 15 min)`,
      '',
      '== memory ==',
      `${gib(totalMem - freeMem)} used · ${gib(freeMem)} free · ${gib(totalMem)} total`,
      '',
      '== disk (root filesystem) ==',
      `${gib(diskTotal - diskAvail)} used · ${gib(diskAvail)} free · ${gib(diskTotal)} total`,
    ].join('\n');
    return ok({ text });
  });

  app.post<{ Body: { service?: string } }>('/system/restart', {
    schema: {
      tags: ['meta'],
      summary: 'Restart a server container (default: the api)',
      description: 'Restarts one compose service\'s container — `api` (the default), `postgres`, `caddy`, ' +
        '`updater`, `autoheal`, `observer`. Goes through the api\'s existing docker proxy, which already ' +
        'permits container restarts; nothing new is exposed. Restarting `api` replies FIRST and restarts ' +
        'half a second later, so the answer always lands — clients should expect the connection to drop ' +
        'right after it.',
      body: {
        type: 'object', additionalProperties: false,
        properties: { service: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$',
          description: 'compose service name (default api)' } },
      },
    },
  }, async (req, reply) => {
    const docker = ctx.fs?.docker;
    if (!docker) return reply.code(503).send(err('restart_unavailable', 'this server has no docker access'));
    const service = req.body?.service ?? 'api';
    const all = await docker.listContainers().catch((e) => {
      log.error({ err: errStr(e) }, 'container list failed');
      return null;
    });
    if (!all) return reply.code(503).send(err('restart_unavailable', 'docker did not answer'));
    const target = all.find((c) => (c.Labels?.['com.docker.compose.service'] ?? '') === service);
    if (!target) {
      const services = [...new Set(all.map((c) => c.Labels?.['com.docker.compose.service']).filter(Boolean))].sort();
      return reply.code(404).send(err('no_such_service',
        `no running container for service "${service}" — running services: ${services.join(', ') || '(none)'}`));
    }
    const container = docker.getContainer(target.Id);
    if (service === 'api') {
      // Reply first: the restart kills this very process, so the answer must
      // be out the door before docker is asked.
      setTimeout(() => {
        container.restart().catch((e) => log.warn({ err: errStr(e) }, 'api self-restart failed'));
      }, 500).unref();
      log.info('api restart requested');
      return ok({ restarting: service, note: 'the api is restarting — back in a few seconds' });
    }
    try {
      await container.restart();
    } catch (e) {
      log.error({ err: errStr(e), service }, 'restart failed');
      return reply.code(503).send(err('restart_unavailable', `could not restart ${service}: ${errStr(e)}`));
    }
    log.info({ service }, 'service restarted');
    return ok({ restarting: service });
  });
}
