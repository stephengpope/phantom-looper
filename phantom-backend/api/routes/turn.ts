// POST /sessions/:id/turn — run one coding-agent turn on a session, server
// side, on the OLD path (core/llm). The route is this app's until the
// backend's own turns run on the client SDK (plan §5); it is registered
// through the API's route door.
import type { FastifyInstance } from 'fastify';
import { ok, err, type PhantomBackend, lockedErr, clientOf } from 'phantom-backend-sdk';
import { openSession, SessionLockedError } from '../../../core/session.js';
import { injectFetch } from '../../looper/injectFetch.js';
import { runCodingTurn } from '../../looper/turn.js';
import { oldAgentConfig, sessionPin } from '../../agentConfig.js';

const TAG = { tags: ['sessions'] } as const;
const idParam = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } as const;

export function turnRoute(app: FastifyInstance, ctx: PhantomBackend, deps: { apiKey: string; modelFetch?: typeof fetch }): void {
  // ---- server-side turns ---------------------------------------------------
  // A server-side turn is a NORMAL session turn whose user message arrives as
  // a string: same openSession, same kits, same frozen
  // prompt, same transcript record — the route is just another headless
  // client of this server's own surface (injectFetch). The reply streams as
  // ND-JSON — {type:text|tool} events as they happen, one final
  // {type:'result'} line — the transport that survives a minutes-long turn.
  app.post<{ Params: { id: string }; Body: { message: string; plan?: boolean } }>(
    '/sessions/:id/turn', { schema: { ...TAG,
      summary: 'Run one coding-agent turn on a session',
      description: 'Sends `message` to the session\'s coding agent and runs the turn to completion ' +
        'server-side. Streams ND-JSON: {type:"text",text} and {type:"tool",name} as they happen, then one ' +
        '{type:"result",text} line. `plan: true` runs the turn with the read-only toolset (plan mode). ' +
        'Holds the session lock for the turn (x-phantom-looper-client names the holder); 409 while someone ' +
        'else holds it. The conversation is saved whole at the end — the same record every client reads.',
      params: idParam,
      body: { type: 'object', required: ['message'], additionalProperties: false,
        properties: { message: { type: 'string', minLength: 1 },
          plan: { type: 'boolean', default: false } } } } },
    async (req, reply) => {
      const client = clientOf(req) || `turn-${Math.random().toString(36).slice(2, 10)}`;
      const f = injectFetch(app);
      let opened;
      try {
        opened = await openSession({ baseUrl: 'http://looper/api', apiKey: deps.apiKey,
          clientId: client, label: client, sessionId: req.params.id, fetch: f, lock: true });
      } catch (e) {
        if (e instanceof SessionLockedError) {
          const s = await ctx.sessions.get(req.params.id);
          return reply.code(409).send(s ? lockedErr(s) : err('session_locked', `session ${req.params.id} is in use`, true));
        }
        if ((e as Error).message.includes('session_not_found') || (e as Error).message.includes('not_found')) {
          return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
        }
        throw e;
      }
      reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const line = (o: unknown) => reply.raw.write(`${JSON.stringify(o)}\n`);
      // This reply is a VIEW of the same feed every watcher reads: subscribe
      // first, then run the turn, and map the parts into the two line shapes
      // this route has always sent. Parts are published in exactly one place
      // (runCodingTurn) — the emitter is synchronous and in-process and the
      // lock guarantees this is the only turn on the session, so subscribing
      // before the run leaves no gap and lets nothing else in.
      const unsubscribe = ctx.sessionEvents.subscribe(req.params.id, (e) => {
        if (e.event !== 'part') return;
        const p = e.part as { type?: string; text?: string; toolName?: string };
        if (p.type === 'text-delta' && p.text) line({ type: 'text', text: p.text });
        else if (p.type === 'tool-call') line({ type: 'tool', name: p.toolName });
      });
      try {
        const project = await ctx.projects.get(opened.session.projectId);
        const cfg = await oldAgentConfig(ctx.agentConfig, ctx.settings, 'coding', project ? { projectId: project.id } : {}, sessionPin(opened.session));
        const { text } = await runCodingTurn(
          { f, apiKey: deps.apiKey, base: 'http://looper/api', modelFetch: deps.modelFetch,
            sessionEvents: ctx.sessionEvents, client, backdoor: ctx.userMessageQueue },
          opened, opened.session.projectId, req.body.message, req.body.plan === true, cfg);
        line({ type: 'result', text });
      } catch (e) {
        line({ type: 'error', message: (e as Error).message });
      } finally {
        unsubscribe();
        await opened.close();
        reply.raw.end();
      }
    });

}
