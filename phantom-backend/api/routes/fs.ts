// The filesystem tool surface. Session travels in a HEADER — it never appears
// in the schema the model sees; the adapter injects it from client config.
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import { workspaces, commands, type SessionRow } from '../../db/schema.js';
import { getSession, touchSession } from '../../sessions.js';
import { newId } from '../../../core/ids.js';
import { sessionDir } from '../../pool/paths.js';
import { logger, errStr } from '../../log.js';
import { Sandbox } from '../../workspace/sandbox.js';
import { TOOLS, type ToolCtx } from '../../tools/registry.js';
import { ToolError } from '../../tools/envelope.js';
import { resolve } from '../../settings.js';
import { ok, err, type AppCtx } from '../app.js';
import { killProcessGroup } from '../foreground.js';
import { SESSION_HEADER } from '../sessionHeader.js';
import type { ContainerManager } from '../../workspace/container.js';
import type Docker from 'dockerode';
import type { GitEngine } from '../../git/engine.js';

const log = logger('bash');

export interface FsDeps { docker: Docker; containers: ContainerManager; engine?: GitEngine }

const STATUS: Record<string, number> = {
  not_found: 404, session_not_found: 404, session_destroyed: 410,
  invalid_args: 400, no_match: 422, not_unique: 422, binary_file: 422,
  is_directory: 400, not_a_directory: 400, too_large: 413,
  busy: 409, container_start_failed: 503, exec_timeout: 504,
};

/** Kill one process SESSION by sid: TERM, ~1s grace, KILL. A second exec is
 *  the only kill Docker offers — the Engine API has no exec-kill (moby#9098),
 *  and detaching the stream leaves the process running. An exec'd command is
 *  a session leader (runc setsids it), so its sid names the whole tree;
 *  `pkill -s` is the one kill-by-session both userlands speak (busybox
 *  builtin on alpine, procps in the workspace image — `kill -- -pgid` is NOT
 *  portable, busybox kill rejects `--`). The killer is its own exec in its
 *  own session — never inside what it kills. The tasks route kills by sid
 *  from the commands row; killProcessGroup (api/foreground.ts) reads it from
 *  a pidfile. */
export function killSid(ws: Sandbox, sid: string): Promise<unknown> {
  const script =
    'pkill -TERM -s "$0" 2>/dev/null; sleep 1; ' +
    'pgrep -s "$0" >/dev/null 2>&1 && pkill -KILL -s "$0" 2>/dev/null; exit 0';
  return ws.run(['/bin/sh', '-c', script, sid], { timeoutMs: 15_000 })
    .catch((e) => log.warn({ err: errStr(e) }, 'kill of command group failed'));
}

// ---- live tasks: what the container is actually running ---------------------
// Shared by the /tasks screen (routes/tasks.ts) and the task_* tools below.
// Everything speaks the CONTAINER's pid namespace: the listing is `ps` run
// inside the container, the kill is `pkill -s` inside it. One task = one
// started command's whole process tree, grouped by process-session id (runc
// setsids every exec, so the leader's pid IS the sid).

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

/** The live groups of a container, one ps. */
export async function probeGroups(ws: Sandbox): Promise<LiveGroup[]> {
  const r = await ws.run(PS_ARGV, { timeoutMs: 15_000 });
  return liveGroups(parsePs(r.stdout.toString('utf8')));
}

/** The command a row ran, as the user typed it: argv is ['/bin/sh','-c',cmd]. */
export const commandOf = (argv: unknown): string => {
  const a = Array.isArray(argv) ? (argv as string[]) : [];
  return a.length === 3 && a[0] === '/bin/sh' && a[1] === '-c' ? a[2] : a.join(' ');
};

export type CmdRow = typeof commands.$inferSelect;

/** Rows still marked running with no live process are provably dead — the
 *  final write was lost (server restart mid-command). Close them on read:
 *  looking is exactly when a stale row matters. Rows whose sid capture is
 *  still in flight (null sid, just born) get a grace window. */
const SID_CAPTURE_GRACE_MS = 15_000;

export async function reconcileRunning(
  ctx: AppCtx, running: CmdRow[], groups: LiveGroup[],
): Promise<void> {
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
}

/** Full bash semantics, injected into the registry's bash tool. Unary runs
 *  to completion and answers; detached records a command row and streams ND-JSON to
 *  work/<id>/logs/ — outside workspace/, where add -A would commit it.
 *  `signal` is the client's disconnect (esc aborted the tool fetch): a unary
 *  command runs under setsid as its own process-group leader, pgid in a
 *  pidfile, and abort or timeout kills the GROUP — children included. The
 *  pidfile is also registered in ctx.foreground, so the interrupt route's
 *  kill reaches turns that have no socket to close (server-side turns ride
 *  injectFetch) — one kill, two doors. */
async function runBash(
  ctx: AppCtx, deps: FsDeps, ws: Sandbox, session: SessionRow,
  args: { cmd: string; cwd?: string; detached?: boolean; timeout?: number },
  signal?: AbortSignal,
): Promise<unknown> {
  const argv = ['/bin/sh', '-c', args.cmd];
  // No timeout by default: a command runs until it finishes. The tool's
  // timeout argument sets one per call; bash_timeout_ms sets a default and
  // bash_timeout_max_ms a ceiling (default two minutes and no ceiling).
  const defaultRaw = await resolve(ctx.db, 'bash_timeout_ms');
  const maxRaw = await resolve(ctx.db, 'bash_timeout_max_ms');
  const defaultMs = defaultRaw == null ? undefined : Number(defaultRaw);
  const maxMs = maxRaw == null ? undefined : Number(maxRaw);
  let timeoutMs = args.timeout && args.timeout > 0 ? args.timeout : defaultMs;
  if (timeoutMs !== undefined && maxMs !== undefined) timeoutMs = Math.min(timeoutMs, maxMs);
  const maxOut = Number(await resolve(ctx.db, 'max_bash_output_bytes'));

  if (!args.detached) {
    if (signal?.aborted) throw new ToolError('interrupted', 'client disconnected before the command started', false);
    // No lock: tools take none — the session/turn lock is the whole story.
    deps.containers.commandStarted(session.id);
    // A docker exec's process is already a session leader (runc setsids it —
    // verified: pid == sid in the container), so $$ in the pidfile IS the
    // sid of the whole command tree. NOT the setsid binary: a group leader
    // makes it fork, and the parent exits 0 — the real exit code is lost.
    // The wrapper (not exec) stays to record the exit code and remove the
    // pidfile on a normal finish; a kill takes it down with its session and
    // removes the pidfile itself. The kill ends the exec, so the awaited run
    // below resolves on its own — no stream teardown needed.
    const pidfile = `/tmp/.phantom-bash-${newId()}.pid`;
    const wrapped = ['/bin/sh', '-c',
      'echo $$ >"$0"; /bin/sh -c "$1"; s=$?; rm -f "$0"; exit $s', pidfile, args.cmd];
    const onAbort = () => { void killProcessGroup(ws, pidfile); };
    signal?.addEventListener('abort', onAbort, { once: true });
    ctx.foreground?.add(session.id, pidfile, ws);
    // Keep the TAIL (errors live at the end) and spill the full output to a
    // file the agent can read — nothing is lost. One shape for a finished
    // command and for one the timeout killed.
    const shape = async (stdout: Buffer, stderr: Buffer): Promise<Record<string, unknown>> => {
      const out: Record<string, unknown> = {};
      const total = stdout.length + stderr.length;
      if (total > maxOut) {
        const spillName = `bash-${newId()}.out`;
        const spillHost = path.join(sessionDir(ctx.paths, session.folderId ?? session.id), 'logs', spillName);
        await fsp.mkdir(path.dirname(spillHost), { recursive: true });
        await fsp.writeFile(spillHost, Buffer.concat([
          stdout, Buffer.from('\n--- stderr ---\n'), stderr,
        ]));
        out.stdout = stdout.subarray(Math.max(0, stdout.length - maxOut)).toString('utf8');
        out.stderr = stderr.subarray(Math.max(0, stderr.length - Math.floor(maxOut / 4))).toString('utf8');
        out.truncated = {
          reason: 'max_bytes', total_bytes: total,
          full_output: `/workspace/logs/${spillName}`,
          hint: 'showing the tail; read full_output (offset/limit) for the rest',
        };
      } else {
        out.stdout = stdout.toString('utf8');
        out.stderr = stderr.toString('utf8');
      }
      return out;
    };
    try {
      // Collect generously; shape() keeps the tail.
      const r = await ws.run(wrapped, { cwd: args.cwd, timeoutMs, maxBytes: 16 * 1024 * 1024 });
      return { exitCode: r.exitCode, ...(await shape(r.stdout, r.stderr)) };
    } catch (e) {
      const te = e as { code?: string; stdout?: Buffer; stderr?: Buffer };
      if (te.code === 'exec_timeout') {
        // The sandbox timeout only tore down the stream; the process is
        // still running. Same kill as an esc — orphans were the old bug.
        void killProcessGroup(ws, pidfile);
        // The kill is an error the agent can act on: what the command printed
        // before it died rides in detail, shaped like a normal result.
        throw new ToolError('exec_timeout',
          `command killed after ${timeoutMs}ms; its output so far is in detail. If it is expected to take longer and is not waiting for input, retry with a larger timeout (or detached=true for something meant to keep running).`,
          true, await shape(te.stdout ?? Buffer.alloc(0), te.stderr ?? Buffer.alloc(0)));
      }
      throw e;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      ctx.foreground?.remove(session.id, pidfile);
      deps.containers.commandEnded(session.id);
      // A long command is the one gap in the idle clock: it touches at start
      // and runs for hours inside this one call. Touch at end too, so the
      // disk sweep's idle gates see the activity the session actually had.
      void touchSession(ctx.db, session.id);
    }
  }

  const cmdId = newId();
  const logPath = path.join(sessionDir(ctx.paths, session.folderId ?? session.id), 'logs', `${cmdId}.ndjson`);
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  await ctx.db.insert(commands).values({
    id: cmdId, sessionId: session.id, argv, status: 'running', logPath,
  });
  deps.containers.commandStarted(session.id);
  // The same $$-to-pidfile idiom as unary above (pid == sid, runc setsids the
  // exec); `exec` keeps one process so the leader stays the command and the
  // exit code passes through the stream untouched. The row keeps the ORIGINAL
  // argv — the wrapper is plumbing, not what the user ran.
  const sidfile = `/tmp/.phantom-cmd-${cmdId}.sid`;
  const wrapped = ['/bin/sh', '-c', 'echo $$ >"$0"; exec /bin/sh -c "$1"', sidfile, args.cmd];
  void (async () => {
    const out = fs.createWriteStream(logPath);
    let exitCode: number | null = null;
    let status = 'exited';
    try {
      for await (const rec of ws.runStream(wrapped, { cwd: args.cwd })) {
        out.write(JSON.stringify(rec) + '\n');
        if (rec.event === 'exit') exitCode = rec.code ?? -1;
        if (rec.event === 'error') status = 'killed';
      }
    } catch (e) {
      status = 'orphaned';
      out.write(JSON.stringify({ seq: -1, event: 'error', reason: 'container_gone' }) + '\n');
      log.warn({ cmdId, err: errStr(e) }, 'detached stream died');
    } finally {
      out.end();
      deps.containers.commandEnded(session.id);
      void touchSession(ctx.db, session.id); // a long detached command is activity, seen only here at its end
      // Conditional on still-running: the tasks route's 'killed' and the
      // reconciler's 'exited' are final — a late stream teardown must not
      // overwrite them.
      await ctx.db.update(commands).set({ status, exitCode, endedAt: new Date() })
        .where(and(eq(commands.id, cmdId), eq(commands.status, 'running'))).catch(() => {});
      // The exit notice rides the session's NEXT turn (notices.ts) — no turn
      // is started for it. Read the row's final word rather than the local
      // `status`: a kill from /tasks or task_kill marks the row first, and
      // the row is the truth.
      const final = await ctx.db.select().from(commands).where(eq(commands.id, cmdId))
        .catch(() => [] as CmdRow[]);
      if (final[0]) ctx.notices?.push(session.id, noticeOf(final[0]));
    }
  })();
  // Sid capture, fire-and-forget beside the stream: retry-read the pidfile
  // (the stream's exec spawn can lag — a just-started container is slow to
  // exec), remove it, stamp the row. A miss leaves sid null — the tasks
  // route tolerates that (the group shows as untracked, never text-matched).
  void (async () => {
    const script =
      's=""; for i in 1 2 3 4 5 6 7 8 9 10; do s=$(cat "$0" 2>/dev/null) && [ -n "$s" ] && break; sleep 0.3; done; ' +
      'rm -f "$0"; printf %s "$s"';
    const r = await ws.run(['/bin/sh', '-c', script, sidfile], { timeoutMs: 10_000 });
    const sid = r.stdout.toString('utf8').trim();
    if (/^\d+$/.test(sid)) await ctx.db.update(commands).set({ sid }).where(eq(commands.id, cmdId));
  })().catch((e) => log.warn({ cmdId, err: errStr(e) }, 'detached sid capture failed'));
  // log_file is the CONTAINER path — the one place the agent can actually
  // read it (the /commands/:id/logs HTTP route is for API clients, which the
  // agent is not). Same mapping as the unary spill file above.
  return { cmd_id: cmdId, log_file: `/workspace/logs/${cmdId}.ndjson` };
}

// ---- the task tools ----------------------------------------------------------
// The agent's own view of its detached commands, over the SAME commands rows
// the /tasks screen reads — one truth, two readers. Injected into the
// registry's task_* tools; the registry stays free of db and docker plumbing.

/** The one-line notice a finished detached command leaves for the next turn. */
function noticeOf(row: CmdRow): string {
  const cmd = commandOf(row.argv);
  const short = cmd.length > 120 ? `${cmd.slice(0, 120)}…` : cmd;
  const what = row.status === 'killed' ? 'was killed'
    : row.status === 'orphaned' ? 'died with its container'
    : `exited, code ${row.exitCode ?? '?'}`;
  return `[background] task ${row.id} ${what} — "${short}"`;
}

const shapeCommand = (r: CmdRow) => ({
  cmd_id: r.id, command: commandOf(r.argv), status: r.status,
  exit_code: r.exitCode, started_at: r.startedAt, ended_at: r.endedAt,
  log_file: `/workspace/logs/${r.id}.ndjson`,
});

async function taskList(ctx: AppCtx, ws: Sandbox, session: SessionRow): Promise<unknown> {
  const rows: CmdRow[] = await ctx.db.select().from(commands)
    .where(eq(commands.sessionId, session.id))
    .orderBy(desc(commands.startedAt)).limit(20);
  const running = rows.filter((r) => r.status === 'running');
  if (running.length) {
    // Reconcile on read so `running` is the truth. A failed ps SKIPS it —
    // rows still answer unreconciled rather than live commands being closed
    // on a bad reading.
    try { await reconcileRunning(ctx, running, await probeGroups(ws)); }
    catch (e) { log.warn({ err: errStr(e) }, 'task_list reconcile skipped — ps failed'); }
  }
  return {
    running: rows.filter((r) => r.status === 'running').map(shapeCommand),
    recent: rows.filter((r) => r.status !== 'running').slice(0, 10).map(shapeCommand),
  };
}

/** One command row of THIS session, or a not_found the model can act on. */
async function ownCommand(ctx: AppCtx, session: SessionRow, cmdId: string): Promise<CmdRow> {
  const rows: CmdRow[] = await ctx.db.select().from(commands)
    .where(and(eq(commands.id, cmdId), eq(commands.sessionId, session.id)));
  if (!rows[0]) throw new ToolError('not_found', `no task ${cmdId} in this session — task_list shows what is running`);
  return rows[0];
}

/** task_wait's ceiling: the tool call is one HTTP request — long, never
 *  unbounded. */
const WAIT_MAX_MS = 300_000;

async function taskWait(ctx: AppCtx, session: SessionRow, cmdId: string, timeoutMs: number): Promise<unknown> {
  let row = await ownCommand(ctx, session, cmdId);
  const deadline = Date.now() + Math.min(Math.max(0, timeoutMs), WAIT_MAX_MS);
  while (row.status === 'running' && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    row = await ownCommand(ctx, session, cmdId);
  }
  if (row.status === 'running') {
    return { ...shapeCommand(row), hint: 'still running — call task_wait again to keep waiting' };
  }
  return { ...shapeCommand(row), tail: await tailLog(row.logPath, 10) };
}

async function taskKill(ctx: AppCtx, ws: Sandbox, session: SessionRow, cmdId: string): Promise<unknown> {
  const row = await ownCommand(ctx, session, cmdId);
  if (row.status !== 'running') return { ...shapeCommand(row), note: 'not running — nothing to kill' };
  if (!row.sid) {
    throw new ToolError('not_ready', `task ${cmdId} has no process id yet (just started) — retry in a moment`, true);
  }
  // Mark first: the detached stream's terminal write is conditioned on
  // status='running', so 'killed' set here is final even if the stream's
  // exit lands a moment later. The same order as the /tasks route's kill.
  await ctx.db.update(commands).set({ status: 'killed', endedAt: new Date() })
    .where(and(eq(commands.id, row.id), eq(commands.status, 'running')));
  await killSid(ws, row.sid);
  return { cmd_id: row.id, status: 'killed' };
}

/** The last `lines` records of a detached command's ND-JSON log, read bounded
 *  from the end — a dev server's log can run for hours. */
async function tailLog(logPath: string, lines: number): Promise<string[]> {
  try {
    const st = await fsp.stat(logPath);
    const from = Math.max(0, st.size - 16_384);
    const fh = await fsp.open(logPath, 'r');
    try {
      const buf = Buffer.alloc(st.size - from);
      await fh.read(buf, 0, buf.length, from);
      const out: string[] = [];
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line) as { data?: string; event?: string; code?: number };
          if (typeof rec.data === 'string') out.push(rec.data.replace(/\n$/, ''));
          else if (rec.event === 'exit') out.push(`[exit ${rec.code}]`);
        } catch { /* the window's partial first line */ }
      }
      return out.slice(-lines);
    } finally { await fh.close(); }
  } catch { return []; }
}

export function fsRoutes(app: FastifyInstance, ctx: AppCtx, deps: FsDeps) {
  // The neutral tool definitions — what every adapter derives from.
  app.get('/tools', { schema: { tags: ['tools'], summary: 'The neutral tool definitions',
    description: 'What every adapter derives from: name, summary, description, JSON Schema input, mutates/streaming flags, and the session header name. The same objects validate requests below.' } },
  async () => ok({
    version: '1',
    sessionHeader: SESSION_HEADER,
    tools: TOOLS.map(({ name, summary, description, input, mutates, streaming }) =>
      ({ name, summary, description, input, mutates, streaming })),
  }));

  // One route per tool, registered from the same schema objects the adapters
  // derive from — validation and documentation cannot drift from the contract.
  for (const def of TOOLS) {
    app.post<{ Body: Record<string, unknown> }>(`/tools/${def.name}`, {
      schema: {
        tags: ['tools'],
        summary: def.summary,
        description: def.description + (def.mutates ? ' Mutating.' : ' Read-only.'),
        headers: {
          type: 'object',
          properties: { [SESSION_HEADER]: { type: 'string', description: 'Session id (ULID). Required — enforced by the handler so the error speaks the envelope.' } },
        },
        body: def.input,
      },
    }, async (req, reply) => {
      const sessionId = String(req.headers[SESSION_HEADER] ?? '');
      if (!sessionId) return reply.code(400).send(err('session_not_found', `missing ${SESSION_HEADER} header`));
      const session = await getSession(ctx.db, sessionId);
      if (!session) return reply.code(404).send(err('session_not_found', `no session ${sessionId}`));
      if (session.status !== 'active') return reply.code(410).send(err('session_destroyed', `session is ${session.status}`));

      const workspaceRows = await ctx.db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId));
      let container;
      try {
        container = await deps.containers.ensure(ctx.db, session, workspaceRows[0]);
      } catch (e) {
        return reply.code(503).send(err('container_start_failed', (e as Error).message, true));
      }
      void touchSession(ctx.db, sessionId);

      const ws = new Sandbox(deps.docker, container);
      // The client aborting its fetch (esc) surfaces as the socket closing
      // with the reply unfinished — the one reliable disconnect signal
      // (onRequestAbort keys off req.aborted, dead since Node 16: it never
      // fires once the JSON body has been read). On normal completion
      // writableFinished is true and nothing aborts.
      const ac = new AbortController();
      reply.raw.on('close', () => { if (!reply.raw.writableFinished) ac.abort(); });
      const toolCtx: ToolCtx = {
        ws,
        sessionId,
        limits: {
          maxReadBytes: Number(await resolve(ctx.db, 'max_read_bytes')),
          maxSearchResults: Number(await resolve(ctx.db, 'max_search_results')),
        },
        runBash: (args) => runBash(ctx, deps, ws, session, args, ac.signal),
        tasks: {
          list: () => taskList(ctx, ws, session),
          wait: (cmdId, timeoutMs) => taskWait(ctx, session, cmdId, timeoutMs),
          kill: (cmdId) => taskKill(ctx, ws, session, cmdId),
        },
      };
      try {
        // Tools take no lock — the agent fans out parallel calls in one turn
        // and they all just run; the session/turn lock is the only lock.
        const data = await def.execute(toolCtx, req.body ?? {});
        return ok(data);
      } catch (e) {
        if (e instanceof ToolError) {
          return reply.code(STATUS[e.code] ?? 400).send(err(e.code, e.message, e.retryable, e.detail));
        }
        throw e;
      }
    });
  }
}
