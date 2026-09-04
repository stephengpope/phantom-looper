// What is running in a session's container, answered fresh on demand — no
// poller, no stored live state. One task = one started command's whole
// process tree, grouped by process-session id (runc setsids every exec, so
// the leader's pid IS the sid). Everything here speaks the CONTAINER's pid
// namespace: the listing is `ps` run inside the container, the kill is
// `pkill -s` inside it. Docker's own /containers/:id/top reports HOST pids
// (verified live) and is deliberately not used — its numbers can never meet
// a `pkill` in the container.
import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { commands } from '../../db/schema.js';
import { getSession } from '../../sessions.js';
import { Sandbox } from '../../workspace/sandbox.js';
import { ok, err, type AppCtx } from '../app.js';
import { killSid, type FsDeps } from './fs.js';
import { logger, errStr } from '../../log.js';

const log = logger('tasks');

const TAG = { tags: ['tasks'] };
const idParam = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };

// One invocation serving both userlands: busybox ps (the alpine test image)
// and procps (the workspace image) both accept -eo with these columns.
const PS_ARGV = ['ps', '-eo', 'pid,sid,etime,args'];

export interface PsRow { pid: string; sid: string; elapsed: string; args: string }

/** Parse `ps -eo pid,sid,etime,args` output. Columns are located by the
 *  header line, defensively — if a userland ever omits SID, each row stands
 *  alone (sid = pid) rather than the parse failing. args is everything after
 *  the fixed columns, spaces preserved. */
export function parsePs(out: string): PsRow[] {
  const lines = out.split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const titles = lines[0].trim().split(/\s+/).map((t) => t.toUpperCase());
  // args/command is last and open-ended; everything before it is one token.
  const fixed = titles.length - 1;
  const col = (name: string) => titles.indexOf(name);
  const iPid = col('PID');
  const iSid = col('SID');
  const iElapsed = col('ELAPSED') >= 0 ? col('ELAPSED') : col('TIME');
  if (iPid < 0) return [];
  const rows: PsRow[] = [];
  for (const line of lines.slice(1)) {
    const m = line.trim().split(/\s+/);
    if (m.length <= fixed) continue;
    const args = m.slice(fixed).join(' ');
    const pid = m[iPid] ?? '';
    if (!/^\d+$/.test(pid)) continue;
    rows.push({
      pid,
      sid: iSid >= 0 && /^\d+$/.test(m[iSid] ?? '') ? m[iSid] : pid,
      elapsed: iElapsed >= 0 ? (m[iElapsed] ?? '') : '',
      args,
    });
  }
  return rows;
}

/** ps's etime — `[[dd-]hh:]mm:ss` on procps and busybox alike — to seconds;
 *  null when the string is anything else. The client never sees raw etime
 *  vocabulary: an untracked task's start time is derived from this, so every
 *  row speaks one field. */
export function elapsedSeconds(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 86_400 + Number(m[2] ?? 0) * 3_600 + Number(m[3]) * 60 + Number(m[4]);
}

export interface LiveGroup { sid: string; command: string; elapsed: string; pids: number }

/** Group ps rows into tasks by sid. Drops the container's own baseline —
 *  docker-init (pid 1) and the `sleep infinity` keeper share sid 1 (verified
 *  live) — and our own ps invocation, which is itself a setsid'd exec and
 *  would otherwise appear as a task on every read. */
export function liveGroups(rows: PsRow[]): LiveGroup[] {
  const bySid = new Map<string, PsRow[]>();
  for (const r of rows) {
    if (r.sid === '1') continue;
    const g = bySid.get(r.sid);
    if (g) g.push(r); else bySid.set(r.sid, [r]);
  }
  const groups: LiveGroup[] = [];
  for (const [sid, g] of bySid) {
    const leader = g.find((r) => r.pid === r.sid) ?? g[0];
    if (g.length === 1 && leader.args === PS_ARGV.join(' ')) continue;
    groups.push({ sid, command: leader.args, elapsed: leader.elapsed, pids: g.length });
  }
  return groups;
}

/** The command a row ran, as the user typed it: argv is ['/bin/sh','-c',cmd]. */
const commandOf = (argv: unknown): string => {
  const a = Array.isArray(argv) ? (argv as string[]) : [];
  return a.length === 3 && a[0] === '/bin/sh' && a[1] === '-c' ? a[2] : a.join(' ');
};

type CmdRow = typeof commands.$inferSelect;

/** Rows still marked running with no live process are provably dead — the
 *  final write was lost (server restart mid-command). Close them here, on
 *  read: looking is exactly when a stale row matters. Rows whose sid capture
 *  is still in flight (null sid, just born) get a grace window. */
const SID_CAPTURE_GRACE_MS = 15_000;

export function tasksRoutes(app: FastifyInstance, ctx: AppCtx, deps: FsDeps) {
  /** The session's container, probed WITHOUT creating one — listing must
   *  never boot a container just to answer "nothing". */
  const probe = async (folderId: string) => {
    const c = deps.docker.getContainer(deps.containers.name(folderId));
    const info = await c.inspect().catch(() => null);
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
    if (!session) return reply.code(404).send(err('session_not_found', req.params.id));

    const { state, container } = await probe(session.folderId ?? session.id);
    let groups: LiveGroup[] = [];
    if (container) {
      const ws = new Sandbox(deps.docker, container);
      try {
        const r = await ws.run(PS_ARGV, { timeoutMs: 15_000 });
        groups = liveGroups(parsePs(r.stdout.toString('utf8')));
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
    const live = new Set(groups.map((g) => g.sid));
    const now = Date.now();
    for (const row of running) {
      if (row.sid && live.has(row.sid)) continue;
      if (!row.sid && now - row.startedAt.getTime() < SID_CAPTURE_GRACE_MS) continue;
      await ctx.db.update(commands)
        .set({ status: 'exited', exitCode: null, endedAt: new Date() })
        .where(and(eq(commands.id, row.id), eq(commands.status, 'running')))
        .catch(() => {});
      row.status = 'exited';
    }

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
    if (!session) return reply.code(404).send(err('session_not_found', req.params.id));
    const { container } = await probe(session.folderId ?? session.id);
    if (!container) return reply.code(404).send(err('no_such_task', 'nothing is running — the container is not up'));

    const ws = new Sandbox(deps.docker, container);
    const r = await ws.run(PS_ARGV, { timeoutMs: 15_000 });
    const groups = liveGroups(parsePs(r.stdout.toString('utf8')));
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
