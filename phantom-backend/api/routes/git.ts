// Git + exec surface. Exec is the one streamable tool; everything else stays
// unary. Detached logs are ND-JSON on the volume at work/<id>/logs/ — NEVER
// under workspace/, where the next push's add -A would commit them.
import type { FastifyInstance, FastifyReply } from 'fastify';
import fsp from 'node:fs/promises';
import { eq } from 'drizzle-orm';
import { workspaces, commands, type SessionRow, type WorkspaceRow } from '../../db/schema.js';
import { getSession, touchSession } from '../../sessions.js';
import { ToolError } from '../../tools/envelope.js';
import { ok, err, type AppCtx } from '../app.js';
import { SESSION_HEADER } from '../sessionHeader.js';
import type { FsDeps } from './fs.js';
import type { GitEngine } from '../../git/engine.js';
import { logger, errStr } from '../../log.js';

const log = logger('exec');

const sessionHeader = {
  type: 'object',
  properties: { [SESSION_HEADER]: { type: 'string', description: 'Session id (ULID)' } },
};

export function gitRoutes(app: FastifyInstance, ctx: AppCtx, deps: FsDeps, engine: GitEngine) {
  // The caller's lock identity ('' when absent — publishSync falls back to
  // the git client). Handed to auto-push/auto-pull as `by`, so the session
  // feed's echo rule skips the window that is already drawing this stream.
  const clientOf = (req: { headers: Record<string, unknown> }): string => {
    const h = req.headers['x-phantom-looper-client'];
    return typeof h === 'string' ? h : '';
  };

  async function resolveSession(req: { headers: Record<string, unknown> }):
    Promise<{ session: SessionRow; workspace: WorkspaceRow }> {
    const sessionId = String(req.headers[SESSION_HEADER] ?? '');
    const session = sessionId ? await getSession(ctx.db, sessionId) : undefined;
    if (!session) throw new ToolError('session_not_found', sessionId || `missing ${SESSION_HEADER}`);
    if (session.status !== 'active') throw new ToolError('session_destroyed', `session is ${session.status}`);
    const workspaceRows = await ctx.db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId));
    if (!workspaceRows.length) throw new ToolError('not_found', 'workspace vanished');
    void touchSession(ctx.db, session.id);
    return { session, workspace: workspaceRows[0] };
  }

  const send = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) => {
    if (e instanceof ToolError) {
      const status = e.code === 'busy' ? 409 : e.code.startsWith('session') ? 404 : 400;
      return reply.code(status).send(err(e.code, e.message, e.retryable));
    }
    throw e;
  };

  app.post('/git/push', { schema: { tags: ['git'], headers: sessionHeader,
    summary: 'Push now',
    description: 'Commit and push the session branch immediately; the quiet cycle also does this automatically. A push never pulls — only pull does.',
    body: { type: 'object', additionalProperties: false } } }, async (req, reply) => {
    try {
      const { session, workspace } = await resolveSession(req);
      const result = await engine.push(session, workspace);
      return ok({ result });
    } catch (e) { return send(reply, e); }
  });

  app.post('/git/pull', { schema: { tags: ['git'], headers: sessionHeader,
    summary: 'Pull base now',
    description: 'Bring origin/<base> under this session\'s work and push the branch: the same flow as auto-push, stopping before the landing. A conflict goes to the session\'s own coding agent. Nothing reaches base.',
    body: { type: 'object', additionalProperties: false } } }, async (req, reply) => {
    try {
      const { session, workspace } = await resolveSession(req);
      const result = await engine.pull(session, workspace);
      return ok({ result });
    } catch (e) { return send(reply, e); }
  });

  app.get('/git/status', { schema: { tags: ['git'], headers: sessionHeader,
    summary: 'What moved on base',
    description: 'Read-only: commits and files on base not yet merged into this session, the count since claim, and what previous pulls brought in.' } },
  async (req, reply) => {
    try {
      const { session, workspace } = await resolveSession(req);
      return ok(await engine.status(session, workspace));
    } catch (e) { return send(reply, e); }
  });

  // The streamed git operations (auto-push, auto-pull) share ONE wire: ND-JSON
  // because neither has a time limit — headers go out at once and every step
  // (plus a heartbeat) keeps the client's body timeout fed. Records are
  // {event:'step', step, detail?}, {event:'heartbeat'}, and exactly one
  // terminal {event:'result', ...} — the operation's own result, or
  // {result:'busy'} / {result:'error', reason} when it threw.
  async function streamRun<Step extends object, Result extends object>(reply: FastifyReply, name: string, sessionId: string,
    run: (onStep: (e: Step) => void) => Promise<Result>): Promise<FastifyReply> {
    reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const write = (o: unknown) => { reply.raw.write(`${JSON.stringify(o)}\n`); };
    const heartbeat = setInterval(() => write({ event: 'heartbeat' }), 15_000);
    try {
      const result = await run((e) => write({ event: 'step', ...e }));
      write({ event: 'result', ...result });
    } catch (e) {
      if (e instanceof ToolError && e.code === 'busy') {
        write({ event: 'result', result: 'busy', reason: e.message });
      } else {
        log.error({ session: sessionId, err: errStr(e) }, `${name} threw`);
        write({ event: 'result', result: 'error', reason: e instanceof Error ? e.message : String(e) });
      }
    } finally {
      clearInterval(heartbeat);
      reply.raw.end();
    }
    return reply;
  }

  // AUTO-PUSH: the whole path to base in one call, streamed as it runs.
  // Result: pushed | nothing | blocked | error | busy (+ reason?, rounds?, sha?).
  app.post('/git/auto-push', { schema: { tags: ['git'], headers: sessionHeader,
    summary: 'Auto-push the session to base',
    description: 'Take the session (busy if a turn holds it), back the branch up, collapse the work into one commit, ' +
      'replay it on origin/<base> (a conflict goes to the session\'s own coding agent), verify against the repo, ' +
      'force-push the branch with a lease, then fast-forward base to it. Base moved meanwhile: replay again, up to 3 rounds. ' +
      'ND-JSON stream: step records, then one result record (pushed | nothing | blocked | error | busy).',
    body: { type: 'object', additionalProperties: false } } },
  async (req, reply) => {
    let session: SessionRow; let workspace: WorkspaceRow;
    try { ({ session, workspace } = await resolveSession(req)); }
    catch (e) { return send(reply, e); }
    const autoPush = ctx.autoPush;
    if (!autoPush) return reply.code(503).send(err('unavailable', 'auto-push is not wired on this server', true));
    return streamRun(reply, 'auto-push', session.id, (onStep) => autoPush(session, workspace, onStep, clientOf(req)));
  });

  // AUTO-PULL: base INTO the session branch in one call, streamed the same way.
  // Result: merged | clean | blocked | error | busy (+ reason?, arrived?, files?, sha?, pushed?).
  app.post('/git/auto-pull', { schema: { tags: ['git'], headers: sessionHeader,
    summary: 'Auto-pull base into the session',
    description: 'Auto-push without the landing. Fetch origin/<base>; nothing behind -> clean. Otherwise back the branch up, ' +
      'collapse the work into one commit, replay it on origin/<base> (a conflict goes to the session\'s own coding agent), ' +
      'verify against the repo, force-push the branch with a lease. Nothing reaches base. ' +
      'ND-JSON stream: step records, then one result record (merged | clean | blocked | error | busy).',
    body: { type: 'object', additionalProperties: false } } },
  async (req, reply) => {
    let session: SessionRow; let workspace: WorkspaceRow;
    try { ({ session, workspace } = await resolveSession(req)); }
    catch (e) { return send(reply, e); }
    const autoPull = ctx.autoPull;
    if (!autoPull) return reply.code(503).send(err('unavailable', 'auto-pull is not wired on this server', true));
    return streamRun(reply, 'auto-pull', session.id, (onStep) => autoPull(session, workspace, onStep, clientOf(req)));
  });

  // ── exec ───────────────────────────────────────────────────────────────────

  // ND-JSON stream: replays the log, then follows until the command ends.
  app.get<{ Params: { cmdId: string } }>('/commands/:cmdId/logs', { schema: { tags: ['commands'],
    summary: 'Detached command log stream',
    description: 'ND-JSON: replays what the command has written, then follows until it ends. Records are {seq, stream: stdout|stderr, data} with exactly one terminal {event: exit|error} record.',
    params: { type: 'object', properties: { cmdId: { type: 'string' } }, required: ['cmdId'] } } },
  async (req, reply) => {
    const rows = await ctx.db.select().from(commands).where(eq(commands.id, req.params.cmdId));
    if (!rows.length) return reply.code(404).send(err('not_found', `no command ${req.params.cmdId}`));
    const cmd = rows[0];
    reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
    let offset = 0;
    for (;;) {
      const buf = await fsp.readFile(cmd.logPath).catch(() => Buffer.alloc(0));
      if (buf.length > offset) { reply.raw.write(buf.subarray(offset)); offset = buf.length; }
      const [row] = await ctx.db.select().from(commands).where(eq(commands.id, cmd.id));
      if (row.status !== 'running') {
        const rest = await fsp.readFile(cmd.logPath).catch(() => Buffer.alloc(0));
        if (rest.length > offset) reply.raw.write(rest.subarray(offset));
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    reply.raw.end();
    return reply;
  });
}
