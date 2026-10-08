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
import type { PhantomBackend } from '@phantom-agent-sdk/backend';
import type { AppExtras } from '../appRoutes.js';
import { err, ok } from '@phantom-agent-sdk/backend';
import { logger, errStr } from '@phantom-agent-sdk/backend';
import { PROVIDERS, isProvider } from '@phantom-agent-sdk/client';
import { DeploymentError, LOG_MAX_TAIL, LOG_SERVICES } from '@phantom-agent-sdk/backend';

const log = logger('system');

export const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

/** The Deployment object's refusal, as the API's answer. */
const systemErr = (reply: { code: (status: number) => { send: (b: unknown) => unknown } }, error: unknown) => {
  if (!(error instanceof DeploymentError)) throw error;
  return reply.code(error.code === 'no_such_service' ? 404 : 503).send(err(error.code, error.message));
};

export function systemRoutes(app: FastifyInstance, ctx: PhantomBackend, extras: AppExtras) {
  // The model catalog, served by the server so every client and the `model`
  // default read ONE list (models.ts: models.dev, an hour in memory, the
  // release's snapshot when it cannot be reached).
  app.get<{ Querystring: { provider?: string } }>('/models', {
    schema: {
      tags: ['meta'],
      summary: 'List a provider\'s models',
      description: 'The models a provider offers, newest first.',
      querystring: { type: 'object', required: ['provider'], properties: {
        provider: { type: 'string', enum: [...PROVIDERS] } } },
    },
  }, async (req, reply) => {
    const provider = req.query.provider ?? '';
    if (!isProvider(provider)) return reply.code(400).send(err('invalid_args', `provider must be one of: ${PROVIDERS.join(', ')}`));
    return ok({ provider: provider, source: ctx.modelCatalog.source(), models: ctx.modelCatalog.modelsFor(provider) });
  });

  app.post('/update', {
    schema: {
      tags: ['meta'],
      summary: 'Update the server',
      description: 'Upgrades the server to a release, streaming progress as one JSON object per line.',
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
    // Stream ND-JSON progress to the client; heartbeats keep the connection
    // alive. The refusals are thrown before the first event; attaching to an
    // update in progress replays events synchronously, so the head goes out
    // with the first write, whichever comes first.
    let run: ReturnType<typeof extras.deployment.update>;
    const head = () => { if (!reply.raw.headersSent) reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' }); };
    const write = (record: unknown) => { head(); reply.raw.write(`${JSON.stringify(record)}\n`); };
    try { run = extras.deployment.update(tag, { restartAnyway }, write); }
    catch (error) {
      if (!(error instanceof DeploymentError)) throw error;
      return reply.code(error.code === 'loops_running' ? 409 : 503).send(err(error.code, error.message, error.retryable));
    }
    head();
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
      summary: 'Read container logs',
      description: 'The recent logs of one of the server\'s containers.',
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
    try { return ok(await extras.deployment.logs(req.body ?? {})); }
    catch (error) { return systemErr(reply, error); }
  });

  app.get('/system/status', {
    schema: {
      tags: ['meta'],
      summary: 'Get server status',
      description: 'The server\'s CPU, load, memory and disk use.',
    },
  }, async () => ok(await extras.deployment.status()));

  app.post<{ Body: { service?: string } }>('/system/restart', {
    schema: {
      tags: ['meta'],
      summary: 'Restart a container',
      description: 'Restarts one of the server\'s containers, the API by default.',
      body: {
        type: 'object', additionalProperties: false,
        properties: { service: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$',
          description: 'compose service name (default api)' } },
      },
    },
  }, async (req, reply) => {
    try { return ok(await extras.deployment.restart(req.body?.service)); }
    catch (error) { return systemErr(reply, error); }
  });

  // ---- token usage report ---------------------------------------------------
  // One query over token_usage for today / last 7 days / last 30 days, per
  // kind × model; tokenReport.ts lays it out.
  app.get('/system/token-usage', {
    schema: {
      tags: ['meta'],
      summary: 'Get the token usage report',
      description: 'Tokens used today, in the last 7 days and in the last 30 days, by agent, provider and model.',
    },
  }, async () => ok(await extras.deployment.tokenUsage(await ctx.settings.clockFor())));
}
