// The server itself, over HTTP: its update (streamed pull and install
// progress), its containers' logs and restarts, the machine's load, the
// token report, the model catalog. Thin over backend.deployment and
// backend.modelCatalog — the SDK's objects, so the SDK's routes. Every one
// is the service role's: an end user has no business restarting the server.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { PhantomBackend } from '../../PhantomBackend.js';
import { PROVIDERS, isProvider } from '@phantom-agent-sdk/client';
import { DeploymentError, LOG_MAX_TAIL, LOG_SERVICES } from '../../upgrade/Deployment.js';
import { err, ok } from '../HttpApi.js';

const SERVICE_ROLE = { serviceRole: true } as const;
const TAG = { tags: ['meta'] } as const;

export const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

/** The Deployment object's refusal, as the API's answer. */
const deploymentErr = (reply: FastifyReply, error: unknown) => {
  if (!(error instanceof DeploymentError)) throw error;
  const status = error.code === 'no_such_service' ? 404 : error.code === 'restart_refused' ? 409 : 503;
  return reply.code(status).send(err(error.code, error.message, error.retryable));
};

export function systemRoutes(app: FastifyInstance, backend: PhantomBackend): void {
  const { deployment } = backend;

  // The model catalog, served by the server so every client and the `model`
  // default read ONE list (ModelCatalog: models.dev, an hour in memory, the
  // release's snapshot when it cannot be reached).
  app.get<{ Querystring: { provider?: string } }>('/models', {
    config: SERVICE_ROLE,
    schema: { ...TAG,
      summary: 'List a provider\'s models',
      description: 'The models a provider offers, newest first.',
      querystring: { type: 'object', required: ['provider'], properties: {
        provider: { type: 'string', enum: [...PROVIDERS] } } },
    },
  }, async (req, reply) => {
    const provider = req.query.provider ?? '';
    if (!isProvider(provider)) return reply.code(400).send(err('invalid_args', `provider must be one of: ${PROVIDERS.join(', ')}`));
    return ok({ provider, source: backend.modelCatalog.source(), models: backend.modelCatalog.modelsFor(provider) });
  });

  app.post('/update', {
    config: SERVICE_ROLE,
    schema: { ...TAG,
      summary: 'Update the server',
      description: 'Upgrades the server to a release, streaming progress as one JSON object per line.',
      body: {
        type: 'object', required: ['tag'], additionalProperties: false,
        properties: {
          tag: { type: 'string', pattern: RELEASE_TAG.source, description: 'Release tag, e.g. v0.2.0 (no prereleases)' },
          restart_anyway: { type: 'boolean', description: 'Update even when the deployment asks to wait (work in flight is interrupted and resumes after the restart). Only a caller whose human was warned should send this.' },
        },
      },
    },
  }, async (req, reply) => {
    const { tag, restart_anyway: restartAnyway } = req.body as { tag: string; restart_anyway?: boolean };
    // Stream ND-JSON progress to the client; heartbeats keep the connection
    // alive. The refusals are thrown before the first event; attaching to an
    // update in progress replays events synchronously, so the head goes out
    // with the first write, whichever comes first.
    let run: ReturnType<typeof deployment.update>;
    const head = () => { if (!reply.raw.headersSent) reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' }); };
    const write = (record: unknown) => { head(); reply.raw.write(`${JSON.stringify(record)}\n`); };
    try { run = deployment.update(tag, { restartAnyway }, write); }
    catch (error) { return deploymentErr(reply, error); }
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
    config: SERVICE_ROLE,
    schema: { ...TAG,
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
    try { return ok(await deployment.logs(req.body ?? {})); }
    catch (error) { return deploymentErr(reply, error); }
  });

  app.get('/system/status', {
    config: SERVICE_ROLE,
    schema: { ...TAG,
      summary: 'Get server status',
      description: 'The server\'s CPU, load, memory and disk use.',
    },
  }, async () => ok(await deployment.status()));

  app.post<{ Body: { service?: string; restart_anyway?: boolean } }>('/system/restart', {
    config: SERVICE_ROLE,
    schema: { ...TAG,
      summary: 'Restart a container',
      description: 'Restarts one of the server\'s containers, the API by default.',
      body: {
        type: 'object', additionalProperties: false,
        properties: {
          service: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$', description: 'compose service name (default api)' },
          restart_anyway: { type: 'boolean', description: 'Restart even when the deployment asks to wait. Only a caller whose human was warned should send this.' },
        },
      },
    },
  }, async (req, reply) => {
    try { return ok(await deployment.restart(req.body?.service, { restartAnyway: req.body?.restart_anyway })); }
    catch (error) { return deploymentErr(reply, error); }
  });

  // One query over token_usage for today / last 7 days / last 30 days, per
  // type × model; tokenReport.ts lays it out.
  app.get('/system/token-usage', {
    config: SERVICE_ROLE,
    schema: { ...TAG,
      summary: 'Get the token usage report',
      description: 'Tokens used today, in the last 7 days and in the last 30 days, by agent, provider and model.',
    },
  }, async () => ok(await deployment.tokenUsage(await backend.settings.clockFor())));
}
