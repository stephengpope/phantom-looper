// What is running in a session's container, answered fresh on demand — no
// poller, no stored live state. One task = one started command's whole
// process tree, grouped by process-session id (runc setsids every exec, so
// the leader's pid IS the sid). The ps reading, grouping and row reconcile
// live in fs.ts beside the command rows they read — shared with the task_*
// tools, so the screen and the agent read one truth. Docker's own
// /containers/:id/top reports HOST pids (verified live) and is deliberately
// not used — its numbers can never meet a `pkill` in the container.
import type { FastifyInstance } from 'fastify';
import { Sandbox } from '../../runtime/Sandbox.js';
import { ok, err } from '../HttpApi.js';
import type { PhantomBackend } from '../../PhantomBackend.js';
import { workspaceOf } from '../../storage/Sessions.js';
import {
  killSid, probeGroups, reconcileRunning, commandTextFromArgv, elapsedSeconds,
  type LiveGroup, fsDeps,
} from './fs.js';
import type { BackgroundTaskRow } from '../../storage/BackgroundTasks.js';
import { logger, errStr } from '../../lib/log.js';

const log = logger('tasks');

const TAG = { tags: ['tasks'] };
const idParam = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };

export function tasksRoutes(app: FastifyInstance, ctx: PhantomBackend) {
  const deps = fsDeps(ctx);
  /** The session's container, probed WITHOUT creating one — listing must
   *  never boot a container just to answer "nothing". */
  const probe = async (workspaceId: string) => {
    const container = deps.docker.getContainer(deps.sessionContainers.name(workspaceId));
    const info = await container.inspect().catch((error: { statusCode?: number; message?: string }) => {
      // 404 IS "absent"; anything else is docker failing to answer.
      if (error.statusCode !== 404) log.warn({ workspace: workspaceId, err: error.message }, 'container inspect failed — listed as absent');
      return null;
    });
    if (!info) return { state: 'absent' as const, container: null };
    if (!info.State.Running) return { state: 'stopped' as const, container: null };
    return { state: 'running' as const, container: container };
  };

  app.get<{ Params: { id: string } }>('/sessions/:id/tasks', { schema: { ...TAG,
    summary: 'List running tasks',
    description: 'The commands running in the session\'s container right now, including background ones the agent started.',
    params: idParam } },
  async (req, reply) => {
    const session = await ctx.sessions.get(req.params.id);
    if (!session) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
    if (!session.workspaceId) return reply.code(400).send(err('no_workspace', 'this session has no files — nothing runs for it'));

    const { state, container } = await probe(workspaceOf(session));
    let groups: LiveGroup[] = [];
    if (container) {
      try {
        groups = await probeGroups(new Sandbox(deps.docker, container));
      } catch (error) {
        log.warn({ session: session.id, err: errStr(error) }, 'ps in container failed');
      }
    }

    const rows: BackgroundTaskRow[] = await ctx.backgroundTasks.listForSession(session.id, 50);
    const running = rows.filter((row) => row.status === 'running');

    const bySid = new Map(running.filter((row) => row.sid).map((row) => [row.sid as string, row]));
    const tasks = groups.map((group) => {
      const row = bySid.get(group.sid);
      // An untracked task still says when it started — derived from ps's
      // elapsed, so the client renders one field the same way for every row.
      const secs = elapsedSeconds(group.elapsed);
      return {
        sid: group.sid,
        command: row ? commandTextFromArgv(row.argv) : group.command,
        background_task_id: row?.id ?? null,
        log_file: row ? `/workspace/logs/${row.id}.ndjson` : null,
        started_at: row?.startedAt ?? (secs == null ? null : new Date(Date.now() - secs * 1000)),
        elapsed: group.elapsed,
        pids: group.pids,
      };
    });

    // Reconcile: running rows with no live group are dead. Applies equally
    // when the container is absent or stopped — nothing survives either.
    await reconcileRunning(ctx, running, groups);

    const liveIds = new Set(tasks.map((task) => task.background_task_id).filter(Boolean));
    const recent = rows
      .filter((row) => row.status !== 'running' && !liveIds.has(row.id))
      .slice(0, 10)
      .map((row) => ({
        background_task_id: row.id,
        command: commandTextFromArgv(row.argv),
        status: row.status,
        exit_code: row.exitCode,
        started_at: row.startedAt,
        ended_at: row.endedAt,
        log_file: `/workspace/logs/${row.id}.ndjson`,
      }));

    return ok({ container: state, tasks, recent });
  });

  app.delete<{ Params: { id: string; sid: string } }>('/sessions/:id/tasks/:sid', { schema: { ...TAG,
    summary: 'Stop a task',
    description: 'Stops one running command in the session\'s container, along with everything it started.',
    params: { type: 'object', properties: { id: { type: 'string' }, sid: { type: 'string' } },
      required: ['id', 'sid'] } } },
  async (req, reply) => {
    const session = await ctx.sessions.get(req.params.id);
    if (!session) return reply.code(404).send(err('session_not_found', `no session ${req.params.id}`));
    if (!session.workspaceId) return reply.code(400).send(err('no_workspace', 'this session has no files — nothing runs for it'));
    const { container } = await probe(workspaceOf(session));
    if (!container) return reply.code(404).send(err('no_such_task', 'nothing is running — the container is not up'));

    const sandbox = new Sandbox(deps.docker, container);
    const groups = await probeGroups(sandbox);
    if (!groups.some((group) => group.sid === req.params.sid)) {
      return reply.code(404).send(err('no_such_task', `no running task with sid ${req.params.sid}`));
    }

    // Mark first: the detached stream's terminal write is conditioned on
    // status='running', so 'killed' set here is final even if the stream's
    // exit lands a moment later.
    const marked = await ctx.backgroundTasks.markKilledBySid(session.id, req.params.sid);
    await killSid(sandbox, req.params.sid);
    return ok({ sid: req.params.sid, background_task_id: marked });
  });

}
