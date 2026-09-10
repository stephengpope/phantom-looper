// What is running in a session's container, answered fresh on demand — no
// poller, no stored live state. One task = one started command's whole
// process tree, grouped by process-session id (runc setsids every exec, so
// the leader's pid IS the sid). The ps reading, grouping and row reconcile
// live in fs.ts beside the command rows they read — shared with the task_*
// tools, so the screen and the agent read one truth. Docker's own
// /containers/:id/top reports HOST pids (verified live) and is deliberately
// not used — its numbers can never meet a `pkill` in the container.
import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { commands } from '../../db/schema.js';
import { getSession } from '../../sessions.js';
import { Sandbox } from '../../workspace/sandbox.js';
import { ok, err, type AppCtx } from '../app.js';
import {
  killSid, probeGroups, reconcileRunning, commandOf, elapsedSeconds,
  type CmdRow, type LiveGroup, type FsDeps,
} from './fs.js';
import { logger, errStr } from '../../log.js';

const log = logger('tasks');

const TAG = { tags: ['tasks'] };
const idParam = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };

export function tasksRoutes(app: FastifyInstance, ctx: AppCtx, deps: FsDeps) {
  /** The session's container, probed WITHOUT creating one — listing must
   *  never boot a container just to answer "nothing". */
  const probe = async (folderId: string) => {
    const c = deps.docker.getContainer(deps.containers.name(folderId));
    const info = await c.inspect().catch((e: { statusCode?: number; message?: string }) => {
      // 404 IS "absent"; anything else is docker failing to answer.
      if (e.statusCode !== 404) log.warn({ folder: folderId, err: e.message }, 'container inspect failed — listed as absent');
      return null;
    });
    if (!info) return { state: 'absent' as const, container: null };
    if (!info.State.Running) return { state: 'stopped' as const, container: null };
    return { state: 'running' as const, container: c };
  };

  app.get<{ Params: { id: string } }>('/sessions/:id/tasks', { schema: { ...TAG,
    summary: 'What is running in the session container right now',
    description: 'Live process trees grouped one-per-started-command, matched to detached-command ' +
      'rows (cmd_id + logs when tracked), plus recent finished commands with exit codes. ' +
      'Reads the container fresh on every call; never starts one.',
    params: idParam } },
  async (req, reply) => {
    const session = await getSession(ctx.db, req.params.id);
    if (!session) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));

    const { state, container } = await probe(session.folderId ?? session.id);
    let groups: LiveGroup[] = [];
    if (container) {
      try {
        groups = await probeGroups(new Sandbox(deps.docker, container));
      } catch (e) {
        log.warn({ session: session.id, err: errStr(e) }, 'ps in container failed');
      }
    }

    const rows: CmdRow[] = await ctx.db.select().from(commands)
      .where(eq(commands.sessionId, session.id))
      .orderBy(desc(commands.startedAt)).limit(50);
    const running = rows.filter((r) => r.status === 'running');

    const bySid = new Map(running.filter((r) => r.sid).map((r) => [r.sid as string, r]));
    const tasks = groups.map((g) => {
      const row = bySid.get(g.sid);
      // An untracked task still says when it started — derived from ps's
      // elapsed, so the client renders one field the same way for every row.
      const secs = elapsedSeconds(g.elapsed);
      return {
        sid: g.sid,
        command: row ? commandOf(row.argv) : g.command,
        cmd_id: row?.id ?? null,
        logs: row ? `/commands/${row.id}/logs` : null,
        log_file: row ? `/workspace/logs/${row.id}.ndjson` : null,
        started_at: row?.startedAt ?? (secs == null ? null : new Date(Date.now() - secs * 1000)),
        elapsed: g.elapsed,
        pids: g.pids,
      };
    });

    // Reconcile: running rows with no live group are dead. Applies equally
    // when the container is absent or stopped — nothing survives either.
    await reconcileRunning(ctx, running, groups);

    const liveIds = new Set(tasks.map((t) => t.cmd_id).filter(Boolean));
    const recent = rows
      .filter((r) => r.status !== 'running' && !liveIds.has(r.id))
      .slice(0, 10)
      .map((r) => ({
        cmd_id: r.id,
        command: commandOf(r.argv),
        status: r.status,
        exit_code: r.exitCode,
        started_at: r.startedAt,
        ended_at: r.endedAt,
        logs: `/commands/${r.id}/logs`,
        log_file: `/workspace/logs/${r.id}.ndjson`,
      }));

    return ok({ container: state, tasks, recent });
  });

  app.delete<{ Params: { id: string; sid: string } }>('/sessions/:id/tasks/:sid', { schema: { ...TAG,
    summary: 'Kill one task by its process-session id',
    description: 'TERM, one second, then KILL — the whole process tree. The sid must name a live, ' +
      'non-baseline group in the container (listed by GET); a tracked command row is marked killed.',
    params: { type: 'object', properties: { id: { type: 'string' }, sid: { type: 'string' } },
      required: ['id', 'sid'] } } },
  async (req, reply) => {
    const session = await getSession(ctx.db, req.params.id);
    if (!session) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
    const { container } = await probe(session.folderId ?? session.id);
    if (!container) return reply.code(404).send(err('no_such_task', 'nothing is running — the container is not up'));

    const ws = new Sandbox(deps.docker, container);
    const groups = await probeGroups(ws);
    if (!groups.some((g) => g.sid === req.params.sid)) {
      return reply.code(404).send(err('no_such_task', `no running task with sid ${req.params.sid}`));
    }

    // Mark first: the detached stream's terminal write is conditioned on
    // status='running', so 'killed' set here is final even if the stream's
    // exit lands a moment later.
    const marked = await ctx.db.update(commands)
      .set({ status: 'killed', endedAt: new Date() })
      .where(and(eq(commands.sessionId, session.id), eq(commands.sid, req.params.sid),
        eq(commands.status, 'running')))
      .returning({ id: commands.id });
    await killSid(ws, req.params.sid);
    return ok({ sid: req.params.sid, cmd_id: marked[0]?.id ?? null });
  });
}
