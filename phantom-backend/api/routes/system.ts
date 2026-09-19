// Server-level operations: the remote upgrade (with streamed pull progress),
// container logs, system status, and token usage.
//
// POST /update {tag} pulls the new images via dockerode (streamed per-image
// download progress as ND-JSON), then hands the release tag to the updater
// sidecar which extracts host files and recreates the stack. The pull happens
// inside the API process (the socket proxy allows IMAGES + POST), so progress
// is observable. The sidecar still owns compose — the API never holds the raw
// docker socket.
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppCtx } from '../app.js';
import { err, ok } from '../app.js';
import { logger, errStr } from '../../log.js';
import { catalog, modelsFor } from '../../models.js';
import { PROVIDERS, isProvider } from '../../../core/llm/createAgent.js';
import { SystemError, LOG_MAX_TAIL, LOG_SERVICES } from '../../system.js';

const log = logger('system');

export const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

/** The System object's refusal, as the API's answer. */
const systemErr = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) => {
  if (!(e instanceof SystemError)) throw e;
  return reply.code(e.code === 'no_such_service' ? 404 : 503).send(err(e.code, e.message));
};

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
      summary: 'Upgrade this server to a release (streamed progress)',
      description: 'Pulls the new images via dockerode and streams ND-JSON progress events: ' +
        '`{event:"pulling", image, percent}` per image, `{event:"pulled"}`, `{event:"restarting"}`, ' +
        'then the stream closes and the sidecar restarts the stack. If an update is already in progress, ' +
        'the stream attaches to it and replays current state. Heartbeats keep the connection alive. ' +
        'While a card has a loop round in flight the route refuses (409 `loops_running`) unless the ' +
        'caller passes `restart_anyway`. `updater_unavailable` (503) means this server has no updater ' +
        'sidecar (UPDATE_TRIGGER_DIR unset) — re-run install.sh once.',
      body: {
        type: 'object', required: ['tag'], additionalProperties: false,
        properties: {
          tag: { type: 'string', pattern: RELEASE_TAG.source, description: 'Release tag, e.g. v0.2.0 (no prereleases)' },
          restart_anyway: { type: 'boolean', description: 'Update even with loop rounds in flight — they are interrupted and resume after the restart. Only a caller whose human was warned should send this.' },
        },
      },
    },
  }, async (req, reply) => {
    const { tag, restart_anyway: restartAnyway } = req.body as { tag: string; restart_anyway?: boolean };
    // Stream ND-JSON progress to the client; heartbeats keep the connection alive.
    let run: ReturnType<typeof ctx.system.update>;
    const write = (o: unknown) => { reply.raw.write(`${JSON.stringify(o)}\n`); };
    try { run = ctx.system.update(tag, { restartAnyway }, write); }
    catch (e) {
      if (!(e instanceof SystemError)) throw e;
      return reply.code(e.code === 'loops_running' ? 409 : 503).send(err(e.code, e.message, e.retryable));
    }
    reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const heartbeat = setInterval(() => write({ event: 'heartbeat' }), 15_000);
    const closed = new Promise<void>((resolve) => reply.raw.on('close', resolve));
    await Promise.race([run.done, closed]);
    clearInterval(heartbeat);
    run.stop();
    reply.raw.end();
    return reply;
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
    try { return ok(await ctx.system.logs(req.body ?? {})); }
    catch (e) { return systemErr(reply, e); }
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
  }, async () => ok(await ctx.system.status()));

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
    try { return ok(await ctx.system.restart(req.body?.service)); }
    catch (e) { return systemErr(reply, e); }
  });

  // ---- token usage report ---------------------------------------------------
  // One query over log_tokens for today / last 7 days / last 30 days, per
  // kind × model; tokenReport.ts lays it out.
  app.get('/system/token-usage', {
    schema: {
      tags: ['meta'],
      summary: 'Token usage report — today, last 7 days, last 30 days; agents and helpers by model',
      description: 'Sums the log_tokens entries. Answers as preformatted `text`.',
    },
  }, async () => ok(await ctx.system.tokenUsage()));
}
