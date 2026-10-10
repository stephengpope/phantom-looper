// The session runners' routes (host/Runners.ts):
//
//   POST   /runners/hello              a host says who it is; its row
//   GET    /runners/:id/jobs           the host's feed: jobs down, ND-JSON, held open
//   POST   /runners/:id/jobs/events    the host's relay: job events up
//   GET    /runners                    the hosts a caller may see, with online
//   DELETE /runners/:id                forget an offline, empty host
//   POST   /runners/:id/update         upgrade one runner to a release (ND-JSON progress)
//   POST   /runners/update             upgrade every online runner behind a release
//   POST   /sessions/:id/move                move a session's workspace to another host
//
// Who may: the service role for shared runners, a user for their own — the row's
// owner, checked on every call in Runners. The feed is the one long
// call; it is a host's "online".
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ok, err } from '../HttpApi.js';
import type { PhantomBackend } from '../../PhantomBackend.js';
import { RunnerError, type HostCaller } from '../../host/Runners.js';
import type { HostHello, JobEvent } from '../../host/protocol.js';
import { WorkspaceError } from '../../storage/Workspaces.js';
import { ownsWorkspace, workspaceOf } from '../../storage/Sessions.js';
import { pushFailed } from '../../git/Git.js';
import { copyScratch } from '../../runtime/scratch.js';
import { logger, errStr } from '../../lib/log.js';

const log = logger('runners');
const TAG = { tags: ['runners'] };
const idParam = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
const STATUS: Record<RunnerError['code'], number> = { not_found: 404, access_denied: 403, no_host: 409, host_online: 409, host_in_use: 409, host_offline: 409, jobs_running: 409 };
const RELEASE_TAG = '^v\\d+\\.\\d+\\.\\d+$';
const UPDATE_BODY = { type: 'object', required: ['tag'], additionalProperties: false, properties: {
  tag: { type: 'string', pattern: RELEASE_TAG, description: 'Release tag, e.g. v0.2.0 (no prereleases)' },
  restart_anyway: { type: 'boolean', description: 'Update even with jobs in flight on the runner — they fail retryable and the callers retry after the restart.' } } };

const callerOf = (req: { caller: { type: string; user?: { id: string } } | null }): HostCaller =>
  req.caller?.type === 'user' ? { admin: false, userId: req.caller.user!.id } : { admin: true, userId: null };

export function runnerRoutes(app: FastifyInstance, ctx: PhantomBackend) {
  const refused = (reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown) => {
    if (error instanceof RunnerError) return reply.code(STATUS[error.code]).send(err(error.code, error.message, error.retryable));
    throw error;
  };
  /** An update's progress as ND-JSON, as POST /update streams the server's:
   *  heartbeats keep the line open; a refusal comes before the first event. */
  const streamUpdate = async (reply: FastifyReply, run: (write: (record: unknown) => void) => Promise<void>) => {
    const head = () => { if (!reply.raw.headersSent) reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' }); };
    const write = (record: unknown) => { head(); if (!reply.raw.destroyed) reply.raw.write(`${JSON.stringify(record)}\n`); };
    const heartbeat = setInterval(() => write({ event: 'heartbeat' }), 15_000);
    try { await run(write); }
    finally { clearInterval(heartbeat); head(); reply.raw.end(); }
    return reply;
  };

  app.post<{ Body: HostHello }>('/runners/hello', { schema: { ...TAG, summary: 'Register a session runner',
    description: 'A session runner announces itself: its name, its persisted id when it has one, and what its box can do. Answers the host\'s row; the host then opens its feed.',
    body: { type: 'object', required: ['name', 'boot', 'facts'], properties: {
      id: { type: 'string' }, name: { type: 'string' }, boot: { type: 'string' },
      facts: { type: 'object', additionalProperties: true } } } } },
  async (req, reply) => {
    try { return ok({ ...(await ctx.runners.hello(callerOf(req), req.body)), heartbeatMs: await ctx.runners.heartbeatMs() }); }
    catch (error) { return refused(reply, error); }
  });

  app.get<{ Params: { id: string }; Querystring: { boot: string } }>('/runners/:id/jobs', { schema: { ...TAG, summary: 'A session runner\'s jobs',
    description: 'The host\'s feed: one JSON object per line, each a job for it to run, with a heartbeat every 15 seconds. Held open by the host; while it is open the host is online.',
    params: idParam, querystring: { type: 'object', required: ['boot'], properties: { boot: { type: 'string' } } } } },
  async (req, reply) => {
    // The host is checked before anything is written; then the headers go,
    // then the attach — which writes every job still pending down this very
    // response, so the headers must already be out.
    const caller = callerOf(req);
    try { await ctx.runners.check(req.params.id, caller); }
    catch (error) { return refused(reply, error); }
    const write = (record: unknown) => {
      if (reply.raw.destroyed) return;
      try { reply.raw.write(`${JSON.stringify(record)}\n`); }
      catch (error) { log.warn({ host: req.params.id, err: errStr(error) }, 'feed write failed — hanging up'); reply.raw.destroy(); }
    };
    reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
    write({ event: 'heartbeat' });
    let detach: (() => Promise<void>) | undefined;
    try {
      detach = await ctx.runners.attach(req.params.id, caller, req.query.boot, (job) => write(job), () => reply.raw.destroy());
    } catch (error) { reply.raw.destroy(); throw error; }
    const heartbeat = setInterval(() => write({ event: 'heartbeat' }), 15_000);
    try {
      await new Promise<void>((resolve) => reply.raw.on('close', resolve));
      return reply;
    } finally {
      clearInterval(heartbeat);
      await detach();
    }
  });

  app.post<{ Params: { id: string }; Body: { events: JobEvent[] } }>('/runners/:id/jobs/events', { schema: { ...TAG, summary: 'Report job events',
    description: 'The host\'s relay: results, chunks, ends and errors of the jobs it runs, in order.',
    params: idParam, body: { type: 'object', required: ['events'], properties: { events: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
    // Chunks of exec output ride here; a generous ceiling.
    bodyLimit: 64 * 1024 * 1024 },
  async (req, reply) => {
    try { await ctx.runners.deliver(req.params.id, callerOf(req), req.body.events); return ok({ delivered: req.body.events.length }); }
    catch (error) { return refused(reply, error); }
  });

  app.get('/runners', { schema: { ...TAG, summary: 'List session runners',
    description: 'The runners this caller may use: the shared ones and their own, each with what it runs (`sessions`: workspaces; `clients`: turns), whether it is online now, how many workspaces are on it, and its load as of its last heartbeat (cpu: load average over cores, 1 = every core busy; freeGB; usedPct; running containers).' } },
  async (req) => ok({ hosts: await ctx.runners.list(callerOf(req)) }));

  app.delete<{ Params: { id: string } }>('/runners/:id', { schema: { ...TAG, summary: 'Forget a session runner',
    description: 'Removes a host\'s registration. Refused while it is connected or while any workspace is still on it.', params: idParam } },
  async (req, reply) => {
    try { await ctx.runners.remove(req.params.id, callerOf(req)); return ok({ removed: req.params.id }); }
    catch (error) { return refused(reply, error); }
  });

  app.post<{ Params: { id: string }; Body: { tag: string; restart_anyway?: boolean } }>('/runners/:id/update', { schema: { ...TAG, summary: 'Update a session runner',
    description: 'Upgrades one runner to a release, streaming progress as one JSON object per line (the same events as POST /update): the runner pulls the images, its updater sidecar recreates it, and the stream ends with `restarting`. Refused while jobs are in flight on it unless restart_anyway.',
    params: idParam, body: UPDATE_BODY } },
  async (req, reply) => {
    const caller = callerOf(req);
    // The refusals come before the first event: checked here, then streamed.
    try { await ctx.runners.check(req.params.id, caller); } catch (error) { return refused(reply, error); }
    return streamUpdate(reply, async (write) => {
      try { await ctx.runners.update(req.params.id, caller, req.body.tag, { restartAnyway: req.body.restart_anyway }, write); }
      catch (error) {
        if (!(error instanceof RunnerError)) throw error;
        if (!reply.raw.headersSent) { reply.raw.writeHead(STATUS[error.code], { 'content-type': 'application/json' }); reply.raw.write(JSON.stringify(err(error.code, error.message, error.retryable))); return; }
        write({ event: 'error', message: error.message });
      }
    });
  });

  app.post<{ Body: { tag: string; restart_anyway?: boolean } }>('/runners/update', { schema: { ...TAG, summary: 'Update every session runner',
    description: 'Upgrades every online runner this caller may use that is not on the release, all at once, streaming one JSON object per line; each event carries `runner` (its id) and `name`. The first line lists the targets. The server itself is not touched: update it first (POST /update), then the runners.',
    body: UPDATE_BODY } },
  async (req, reply) => {
    const caller = callerOf(req);
    const targets = await ctx.runners.behind(caller, req.body.tag);
    return streamUpdate(reply, async (write) => {
      write({ event: 'targets', runners: targets.map((row) => ({ runner: row.id, name: row.name, version: row.version })) });
      await ctx.runners.updateAll(caller, req.body.tag, { restartAnyway: req.body.restart_anyway }, write);
    });
  });

  // THE MOVE — a workspace from one host to another, in this order and no
  // other: push the branch from where it is, remove the container and the
  // files there, re-pin, clone the branch where it goes. The transcript is
  // in the database and the branch is on origin, so the session carries on.
  // An offline source cannot push: `force` leaves whatever is unpushed on
  // that box behind — the caller's decision, said out loud.
  app.post<{ Params: { id: string }; Body: { runner_id: string | null; force?: boolean; wait_ms?: number } }>('/sessions/:id/move', { schema: { ...TAG, summary: 'Move a session to a host',
    description: 'Moves the session\'s workspace to the named session runner (null: this server). New tool calls wait; a command already running is waited for (wait_ms, default two minutes) so the move happens between two tool calls; then the branch is pushed, the scratch pad carried over, the container and files removed where they were, and the branch checked out on the new host. Detached tasks die with the container. force: move even when the current host is offline (leaving unpushed work there) or a command outlasts wait_ms (killing it).',
    params: idParam, body: { type: 'object', required: ['runner_id'], properties: { runner_id: { type: ['string', 'null'] }, force: { type: 'boolean' }, wait_ms: { type: 'integer', minimum: 0 } } } } },
  async (req, reply) => {
    const session = await ctx.sessions.get(req.params.id);
    if (!session) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
    if (!ownsWorkspace(session)) return reply.code(400).send(err('no_workspace', 'this session has no checkout of its own — move the session whose workspace it reads'));
    const project = await ctx.projects.get(session.projectId);
    if (!project) return reply.code(404).send(err('not_found', 'project vanished'));
    const workspaceId = workspaceOf(session);
    const workspace = (await ctx.workspaces.get(workspaceId))!;
    const target = ctx.runners.byId(req.body.runner_id);
    if (!target) return reply.code(404).send(err('not_found', `no session runner ${req.body.runner_id}`));
    const from = await ctx.runners.of(workspaceId);
    if (from.id === target.id) return ok({ moved: false, runner_id: target.id });
    if (!target.online) return reply.code(409).send(err('host_offline', `${target.name} is offline`));
    if (!from.online && !req.body.force) {
      return reply.code(409).send(err('host_offline', `${from.name} is offline — its unpushed work cannot be pushed first; pass force to leave it behind`));
    }

    // The move, with every tool call for this workspace waiting it out: push
    // the branch where it is, carry the scratch pad over, remove the
    // container and files there, re-pin, check the branch out where it goes.
    // A running command on the old host dies with its container and its tool
    // call answers an error the agent retries — on the new host.
    const moved = await ctx.runners.moving(workspaceId, async (): Promise<{ status: number; body: unknown }> => {
      // THE SAFE STATE: nothing running on this workspace — no command in
      // flight, no background task. New tool calls are already held (moving);
      // what runs is given wait_ms to end. Past that: refused, or killed with
      // the container when forced.
      const onWorkspace = await ctx.sessions.idsOnWorkspace(workspaceId);
      const running = async () => ctx.foregroundCommands.inFlight(onWorkspace) + await ctx.backgroundTasks.countRunning(onWorkspace);
      const waitMs = req.body.wait_ms ?? 120_000;
      const deadline = Date.now() + waitMs;
      while (await running() > 0 && Date.now() < deadline) await new Promise((wake) => setTimeout(wake, 500));
      if (await running() > 0) {
        if (!req.body.force) return { status: 409, body: err('busy', `something is still running on this workspace after ${waitMs}ms (a command, or a background task) — nothing was moved; wait, or pass force to kill it`, true) };
        log.warn({ session: session.id }, 'move: something still runs — forced, it dies with the container');
      }
      // ALL OR NOTHING: nothing on the old host is removed until the new host
      // holds the branch and the scratch pad. A failure before that leaves
      // the session exactly where it was, and what was made on the new host
      // is removed.
      const sourceHasFiles = from.online && workspace.onDisk;
      if (sourceHasFiles) {
        const pushed = await ctx.git.sync.push(session, project);
        if (pushed !== 'pushed' && pushed !== 'nothing') {
          if (!req.body.force) return { status: 409, body: err('unpushed_work', `could not push the session's work first (${pushFailed(pushed) ? pushed.error : pushed}) — nothing was moved; pass force to leave it behind`, true) };
          log.warn({ session: session.id, result: pushed }, 'move: push failed — forced, work left behind');
        }
      }
      try {
        await ctx.workspaces.checkoutOn(target, workspace, project);
        if (sourceHasFiles) await copyScratch(from, workspaceId, target, workspaceId);
      } catch (error) {
        await target.removeFiles(workspaceId).catch((cleanup) => log.warn({ session: session.id, err: errStr(cleanup) }, 'move: could not clean up the new host after a failure'));
        const reason = error instanceof WorkspaceError ? error.message : errStr(error);
        log.warn({ session: session.id, to: target.name, reason }, 'move failed — nothing was moved');
        return { status: 502, body: err(error instanceof WorkspaceError ? error.code : 'move_failed', `could not set the session up on ${target.name}: ${reason} — nothing was moved`, true) };
      }
      if (sourceHasFiles) {
        await from.containerRemove(workspaceId).catch((error) => log.warn({ session: session.id, err: errStr(error) }, 'move: container could not be removed on the old host'));
        await from.removeFiles(workspaceId).catch((error) => log.warn({ session: session.id, err: errStr(error) }, 'move: files could not be removed on the old host'));
      }
      await ctx.runners.pin(workspaceId, target.id);
      if (!workspace.onDisk) await ctx.workspaces.restore({ ...workspace, runnerId: target.id }, project).catch(() => {});
      log.info({ session: session.id, from: from.name, to: target.name }, 'session moved');
      return { status: 200, body: ok({ moved: true, runner_id: target.id }) };
    }).catch((error) => { if (error instanceof RunnerError) return { status: STATUS[error.code], body: err(error.code, error.message) }; throw error; });
    return reply.code(moved.status).send(moved.body);
  });
}
