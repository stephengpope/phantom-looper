// The file-tool plumbing: the session's container, bash (unary and detached)
// and the task_* view over the detached commands. The tools themselves are
// tools/files.ts; the routes that run them are routes/tools.ts.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SessionRow } from '../../storage/schema.js';
import type { BackgroundTaskRow } from '../../storage/BackgroundTasks.js';
import type { BackgroundTaskEnd } from '../../storage/BackgroundTasks.js';
import { newId } from 'phantom-client-sdk';
import { sessionDir } from '../../lib/paths.js';
import { logger, errStr } from '../../lib/log.js';
import { Sandbox } from '../../runtime/Sandbox.js';
import type { FileTools } from '../../tools/def.js';
import { ToolError } from '../../tools/envelope.js';
import type { PhantomBackend } from '../../PhantomBackend.js';
import { killProcessGroup } from '../../agents/ForegroundCommands.js';
import { workspaceOf } from '../../storage/Sessions.js';
import type { SessionContainers } from '../../runtime/SessionContainers.js';
import type Docker from 'dockerode';

const log = logger('bash');

/** The container plumbing the file tools run on. */
export interface FsDeps { docker: Docker; sessionContainers: SessionContainers }
/** The backend's own. */
export const fsDeps = (ctx: PhantomBackend): FsDeps => ({ docker: ctx.docker, sessionContainers: ctx.sessionContainers });


/** Kill one process SESSION by sid: TERM, ~1s grace, KILL. A second exec is
 *  the only kill Docker offers — the Engine API has no exec-kill (moby#9098),
 *  and detaching the stream leaves the process running. An exec'd command is
 *  a session leader (runc setsids it), so its sid names the whole tree;
 *  `pkill -s` is the one kill-by-session both userlands speak (busybox
 *  builtin on alpine, procps in the workspace image — `kill -- -pgid` is NOT
 *  portable, busybox kill rejects `--`). The killer is its own exec in its
 *  own session — never inside what it kills. The tasks route kills by sid
 *  from the background_tasks row; killProcessGroup (api/foreground.ts) reads it from
 *  a pidfile. */
export function killSid(sandbox: Sandbox, sid: string): Promise<unknown> {
  const script =
    'pkill -TERM -s "$0" 2>/dev/null; sleep 1; ' +
    'pgrep -s "$0" >/dev/null 2>&1 && pkill -KILL -s "$0" 2>/dev/null; exit 0';
  return sandbox.run(['/bin/sh', '-c', script, sid], { timeoutMs: 15_000 })
    .catch((error) => log.warn({ err: errStr(error) }, 'kill of command group failed'));
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
  const lines = out.split('\n').filter((line) => line.trim() !== '');
  if (!lines.length) return [];
  const titles = lines[0].trim().split(/\s+/).map((title) => title.toUpperCase());
  // args/command is last and open-ended; everything before it is one token.
  const fixed = titles.length - 1;
  const col = (name: string) => titles.indexOf(name);
  const iPid = col('PID');
  const iSid = col('SID');
  const iElapsed = col('ELAPSED') >= 0 ? col('ELAPSED') : col('TIME');
  if (iPid < 0) return [];
  const rows: PsRow[] = [];
  for (const line of lines.slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length <= fixed) continue;
    const args = columns.slice(fixed).join(' ');
    const pid = columns[iPid] ?? '';
    if (!/^\d+$/.test(pid)) continue;
    rows.push({
      pid,
      sid: iSid >= 0 && /^\d+$/.test(columns[iSid] ?? '') ? columns[iSid] : pid,
      elapsed: iElapsed >= 0 ? (columns[iElapsed] ?? '') : '',
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
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim());
  if (!match) return null;
  return Number(match[1] ?? 0) * 86_400 + Number(match[2] ?? 0) * 3_600 + Number(match[3]) * 60 + Number(match[4]);
}

export interface LiveGroup { sid: string; command: string; elapsed: string; pids: number }

/** Group ps rows into tasks by sid. Drops the container's own baseline —
 *  docker-init (pid 1) and the `sleep infinity` keeper share sid 1 (verified
 *  live) — and our own ps invocation, which is itself a setsid'd exec and
 *  would otherwise appear as a task on every read. */
export function liveGroups(rows: PsRow[]): LiveGroup[] {
  const bySid = new Map<string, PsRow[]>();
  for (const row of rows) {
    if (row.sid === '1') continue;
    const group = bySid.get(row.sid);
    if (group) group.push(row); else bySid.set(row.sid, [row]);
  }
  const groups: LiveGroup[] = [];
  for (const [sid, group] of bySid) {
    const leader = group.find((row) => row.pid === row.sid) ?? group[0];
    if (group.length === 1 && leader.args === PS_ARGV.join(' ')) continue;
    groups.push({ sid, command: leader.args, elapsed: leader.elapsed, pids: group.length });
  }
  return groups;
}

/** The live groups of a container, one ps. */
export async function probeGroups(sandbox: Sandbox): Promise<LiveGroup[]> {
  const ran = await sandbox.run(PS_ARGV, { timeoutMs: 15_000 });
  return liveGroups(parsePs(ran.stdout.toString('utf8')));
}

/** The command a row ran, as the user typed it: argv is ['/bin/sh','-c',cmd]. */
export const commandTextFromArgv = (argv: unknown): string => {
  const a = Array.isArray(argv) ? (argv as string[]) : [];
  return a.length === 3 && a[0] === '/bin/sh' && a[1] === '-c' ? a[2] : a.join(' ');
};


/** Rows still marked running with no live process are provably dead — the
 *  final write was lost (server restart mid-command). Close them on read:
 *  looking is exactly when a stale row matters. Rows whose sid capture is
 *  still in flight (null sid, just born) get a grace window. */
const SID_CAPTURE_GRACE_MS = 15_000;

export async function reconcileRunning(
  ctx: PhantomBackend, running: BackgroundTaskRow[], groups: LiveGroup[],
): Promise<void> {
  const live = new Set(groups.map((group) => group.sid));
  const now = Date.now();
  for (const row of running) {
    if (row.sid && live.has(row.sid)) continue;
    if (!row.sid && now - row.startedAt.getTime() < SID_CAPTURE_GRACE_MS) continue;
    await ctx.backgroundTasks.finish(row.id, 'exited', null).catch(() => {});
    row.status = 'exited';
  }
}

/** Full bash semantics, injected into the registry's bash tool. Unary runs
 *  to completion and answers; detached records a command row and streams ND-JSON to
 *  work/<id>/logs/ — outside project/, where add -A would commit it.
 *  `signal` is the client's disconnect (esc aborted the tool fetch): a unary
 *  command runs under setsid as its own process-group leader, pgid in a
 *  pidfile, and abort or timeout kills the GROUP — children included. The
 *  pidfile is also registered in ctx.foregroundCommands, so the interrupt route's
 *  kill reaches a command whose turn has no socket of its own to close — one
 *  kill, two doors. */
async function runBash(
  ctx: PhantomBackend, deps: FsDeps, sandbox: Sandbox, session: SessionRow,
  args: { cmd: string; cwd?: string; detached?: boolean; timeout?: number },
  signal?: AbortSignal,
): Promise<unknown> {
  const argv = ['/bin/sh', '-c', args.cmd];
  // No timeout by default: a command runs until it finishes. The tool's
  // timeout argument sets one per call; bash_timeout_ms sets a default and
  // bash_timeout_max_ms a ceiling (default two minutes and no ceiling).
  const limits = await ctx.settings.resolveMany(
    ['bash_timeout_ms', 'bash_timeout_max_ms', 'max_bash_output_bytes']);
  const defaultMs = limits.bash_timeout_ms == null ? undefined : Number(limits.bash_timeout_ms);
  const maxMs = limits.bash_timeout_max_ms == null ? undefined : Number(limits.bash_timeout_max_ms);
  let timeoutMs = args.timeout && args.timeout > 0 ? args.timeout : defaultMs;
  if (timeoutMs !== undefined && maxMs !== undefined) timeoutMs = Math.min(timeoutMs, maxMs);
  const maxOut = Number(limits.max_bash_output_bytes);

  if (!args.detached) {
    if (signal?.aborted) throw new ToolError('interrupted', 'client disconnected before the command started', false);
    // No lock: tools take none — the session/turn lock is the whole story.
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
    const onAbort = () => { void killProcessGroup(sandbox, pidfile); };
    signal?.addEventListener('abort', onAbort, { once: true });
    ctx.foregroundCommands.add(session.id, pidfile, sandbox);
    // Keep the TAIL (errors live at the end) and spill the full output to a
    // file the agent can read — nothing is lost. One shape for a finished
    // command and for one the timeout killed.
    const shape = async (stdout: Buffer, stderr: Buffer): Promise<Record<string, unknown>> => {
      const out: Record<string, unknown> = {};
      const total = stdout.length + stderr.length;
      if (total > maxOut) {
        const spillName = `bash-${newId()}.out`;
        const spillHost = path.join(sessionDir(ctx.paths, workspaceOf(session)), 'logs', spillName);
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
      const ran = await sandbox.run(wrapped, { cwd: args.cwd, timeoutMs, maxBytes: 16 * 1024 * 1024 });
      return { exitCode: ran.exitCode, ...(await shape(ran.stdout, ran.stderr)) };
    } catch (error) {
      const timedOut = error as { code?: string; stdout?: Buffer; stderr?: Buffer };
      if (timedOut.code === 'exec_timeout') {
        // The sandbox timeout only tore down the stream; the process is
        // still running. Same kill as an esc — orphans were the old bug.
        void killProcessGroup(sandbox, pidfile);
        // The kill is an error the agent can act on: what the command printed
        // before it died rides in detail, shaped like a normal result.
        throw new ToolError('exec_timeout',
          `command killed after ${timeoutMs}ms; its output so far is in detail. If it is expected to take longer and is not waiting for input, retry with a larger timeout (or detached=true for something meant to keep running).`,
          true, await shape(timedOut.stdout ?? Buffer.alloc(0), timedOut.stderr ?? Buffer.alloc(0)));
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      ctx.foregroundCommands.remove(session.id, pidfile);
      void ctx.sessions.touch(session);
    }
  }

  const taskId = newId();
  const logPath = path.join(sessionDir(ctx.paths, workspaceOf(session)), 'logs', `${taskId}.ndjson`);
  await fsp.mkdir(path.dirname(logPath), { recursive: true });
  await ctx.backgroundTasks.start({ id: taskId, sessionId: session.id, argv, logPath });
  // The same $$-to-pidfile idiom as unary above (pid == sid, runc setsids the
  // exec); `exec` keeps one process so the leader stays the command and the
  // exit code passes through the stream untouched. The row keeps the ORIGINAL
  // argv — the wrapper is plumbing, not what the user ran.
  const sidfile = `/tmp/.phantom-cmd-${taskId}.sid`;
  const wrapped = ['/bin/sh', '-c', 'echo $$ >"$0"; exec /bin/sh -c "$1"', sidfile, args.cmd];
  void (async () => {
    const out = fs.createWriteStream(logPath);
    let exitCode: number | null = null;
    let status: BackgroundTaskEnd = 'exited';
    try {
      for await (const rec of sandbox.runStream(wrapped, { cwd: args.cwd })) {
        out.write(JSON.stringify(rec) + '\n');
        if (rec.event === 'exit') exitCode = rec.code ?? -1;
        if (rec.event === 'error') status = 'killed';
      }
    } catch (error) {
      status = 'orphaned';
      out.write(JSON.stringify({ seq: -1, event: 'error', reason: 'container_gone' }) + '\n');
      log.warn({ taskId, err: errStr(error) }, 'detached stream died');
    } finally {
      out.end();
      void ctx.sessions.touch(session); // a long detached command is activity, seen only here at its end
      // Conditional on still-running: the tasks route's 'killed' and the
      // reconciler's 'exited' are final — a late stream teardown must not
      // overwrite them.
      await ctx.backgroundTasks.finish(taskId, status, exitCode).catch(() => {});
      // The exit message rides the session's NEXT turn through the user
      // message queue (UserMessageQueue) — no turn is started for it. Read the
      // row's final word rather than the local `status`: a kill from /tasks
      // or task_kill marks the row first, and the row is the truth.
      const final = await ctx.backgroundTasks.get(taskId).catch(() => undefined);
      if (final) ctx.userMessageQueue.push(session.id, noticeOf(final));
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
    const ran = await sandbox.run(['/bin/sh', '-c', script, sidfile], { timeoutMs: 10_000 });
    const sid = ran.stdout.toString('utf8').trim();
    if (/^\d+$/.test(sid)) await ctx.backgroundTasks.setSid(taskId, sid);
  })().catch((error) => log.warn({ taskId, err: errStr(error) }, 'detached sid capture failed'));
  // log_file is the CONTAINER path — the one place the agent can actually
  // read it (the /background-tasks/:id/logs HTTP route is for API clients, which the
  // agent is not). Same mapping as the unary spill file above.
  return { background_task_id: taskId, log_file: `/workspace/logs/${taskId}.ndjson` };
}

// ---- the task tools ----------------------------------------------------------
// The agent's own view of its background tasks, over the SAME background_tasks rows
// the /tasks screen reads — one truth, two readers. Injected into the
// registry's task_* tools; the registry stays free of db and docker plumbing.

/** The one-line notice a finished detached command leaves for the next turn.
 *  Id and outcome only — the agent started the command, and task_list has
 *  the full text if it needs it. */
function noticeOf(row: BackgroundTaskRow): string {
  const what = row.status === 'killed' ? 'was killed'
    : row.status === 'orphaned' ? 'died with its container'
    : `exited, code ${row.exitCode ?? '?'}`;
  return `[background] task ${row.id} ${what}`;
}

const shapeBackgroundTask = (row: BackgroundTaskRow) => ({
  background_task_id: row.id, command: commandTextFromArgv(row.argv), status: row.status,
  exit_code: row.exitCode, started_at: row.startedAt, ended_at: row.endedAt,
  log_file: `/workspace/logs/${row.id}.ndjson`,
});

async function taskList(ctx: PhantomBackend, sandbox: Sandbox, session: SessionRow): Promise<unknown> {
  const rows = await ctx.backgroundTasks.listForSession(session.id, 20);
  const running = rows.filter((row) => row.status === 'running');
  if (running.length) {
    // Reconcile on read so `running` is the truth. A failed ps SKIPS it —
    // rows still answer unreconciled rather than live commands being closed
    // on a bad reading.
    try { await reconcileRunning(ctx, running, await probeGroups(sandbox)); }
    catch (error) { log.warn({ err: errStr(error) }, 'task_list reconcile skipped — ps failed'); }
  }
  return {
    running: rows.filter((row) => row.status === 'running').map(shapeBackgroundTask),
    recent: rows.filter((row) => row.status !== 'running').slice(0, 10).map(shapeBackgroundTask),
  };
}

/** One command row of THIS session, or a not_found the model can act on. */
async function ownBackgroundTask(ctx: PhantomBackend, session: SessionRow, taskId: string): Promise<BackgroundTaskRow> {
  const row = await ctx.backgroundTasks.getInSession(taskId, session.id);
  if (!row) throw new ToolError('not_found', `no task ${taskId} in this session — task_list shows what is running`);
  return row;
}

/** task_wait's ceiling: the tool call is one HTTP request — long, never
 *  unbounded. */
const WAIT_MAX_MS = 300_000;

async function taskWait(ctx: PhantomBackend, session: SessionRow, taskId: string, timeoutMs: number): Promise<unknown> {
  let row = await ownBackgroundTask(ctx, session, taskId);
  const deadline = Date.now() + Math.min(Math.max(0, timeoutMs), WAIT_MAX_MS);
  while (row.status === 'running' && Date.now() < deadline) {
    await new Promise((wake) => setTimeout(wake, 1_000));
    row = await ownBackgroundTask(ctx, session, taskId);
  }
  if (row.status === 'running') {
    return { ...shapeBackgroundTask(row), hint: 'still running — call task_wait again to keep waiting' };
  }
  return { ...shapeBackgroundTask(row), tail: await tailLog(row.logPath, 10) };
}

async function taskKill(ctx: PhantomBackend, sandbox: Sandbox, session: SessionRow, taskId: string): Promise<unknown> {
  const row = await ownBackgroundTask(ctx, session, taskId);
  if (row.status !== 'running') return { ...shapeBackgroundTask(row), note: 'not running — nothing to kill' };
  if (!row.sid) {
    throw new ToolError('not_ready', `task ${taskId} has no process id yet (just started) — retry in a moment`, true);
  }
  // Mark first: the detached stream's terminal write is conditioned on
  // status='running', so 'killed' set here is final even if the stream's
  // exit lands a moment later. The same order as the /tasks route's kill.
  await ctx.backgroundTasks.markKilled(row.id);
  await killSid(sandbox, row.sid);
  return { background_task_id: row.id, status: 'killed' };
}

/** The last `lines` records of a detached command's ND-JSON log, read bounded
 *  from the end — a dev server's log can run for hours. */
async function tailLog(logPath: string, lines: number): Promise<string[]> {
  try {
    const stat = await fsp.stat(logPath);
    const from = Math.max(0, stat.size - 16_384);
    const fileHandle = await fsp.open(logPath, 'r');
    try {
      const buf = Buffer.alloc(stat.size - from);
      await fileHandle.read(buf, 0, buf.length, from);
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
    } finally { await fileHandle.close(); }
  } catch { return []; }
}

/** The session's files for a tool call (tools/def.ts FileTools): the
 *  container started (or already up), the sandbox on it, the bash and task
 *  plumbing wired around it. `signal` is the client's disconnect — a unary
 *  bash command is killed on it. Throws ToolError container_start_failed. */
export async function fileTools(ctx: PhantomBackend, deps: FsDeps, session: SessionRow, workspaceId: string, signal: AbortSignal): Promise<FileTools> {
  const project = await ctx.projects.get(session.projectId);
  let container;
  try {
    container = await deps.sessionContainers.ensure(workspaceId, project);
  } catch (error) {
    throw new ToolError('container_start_failed', (error as Error).message, true);
  }
  const sandbox = new Sandbox(deps.docker, container);
  const readLimits = await ctx.settings.resolveMany(['max_read_bytes', 'max_search_results']);
  return {
    sandbox,
    limits: {
      maxReadBytes: Number(readLimits.max_read_bytes),
      maxSearchResults: Number(readLimits.max_search_results),
    },
    runBash: (args) => runBash(ctx, deps, sandbox, session, args, signal),
    tasks: {
      list: () => taskList(ctx, sandbox, session),
      wait: (taskId, timeoutMs) => taskWait(ctx, session, taskId, timeoutMs),
      kill: (taskId) => taskKill(ctx, sandbox, session, taskId),
    },
  };
}
