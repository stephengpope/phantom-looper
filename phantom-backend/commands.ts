// The command row's one owner: every detached bash command a session runs —
// its argv, its log file, its container-namespace session id (sid) once
// captured, and how it ended. The status column's rule lives here: a row
// leaves 'running' exactly once. The kill from /tasks and the reconciler's
// 'exited' are final; a late stream teardown must not overwrite them, so
// every terminal write is conditioned on the row still running.
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { commands } from './db/schema.js';

export type CommandRow = typeof commands.$inferSelect;
/** How a running command ends: on its own, by a kill, or because its
 *  container went away under it. */
export type CommandEnd = 'exited' | 'killed' | 'orphaned';

export class Commands {
  constructor(private readonly db: Db) {}

  async get(id: string): Promise<CommandRow | undefined> {
    const rows = await this.db.select().from(commands).where(eq(commands.id, id));
    return rows[0];
  }

  /** The command, only if it belongs to this session — the agent's own view. */
  async getInSession(id: string, sessionId: string): Promise<CommandRow | undefined> {
    const rows = await this.db.select().from(commands)
      .where(and(eq(commands.id, id), eq(commands.sessionId, sessionId)));
    return rows[0];
  }

  /** A session's commands, newest first. */
  async listForSession(sessionId: string, limit: number): Promise<CommandRow[]> {
    return this.db.select().from(commands)
      .where(eq(commands.sessionId, sessionId))
      .orderBy(desc(commands.startedAt)).limit(limit);
  }

  /** A detached command began: the row keeps the ORIGINAL argv — the shell
   *  wrapper that captures the sid is plumbing, not what the user ran. */
  async start(row: { id: string; sessionId: string; argv: string[]; logPath: string }): Promise<void> {
    await this.db.insert(commands).values({ ...row, status: 'running' });
  }

  /** The process tree's session id landed (captured from the pidfile). */
  async setSid(id: string, sid: string): Promise<void> {
    await this.db.update(commands).set({ sid }).where(eq(commands.id, id));
  }

  /** The stream ended: how, and with what code. Only a running row takes it. */
  async finish(id: string, status: CommandEnd, exitCode: number | null): Promise<void> {
    await this.db.update(commands).set({ status, exitCode, endedAt: new Date() })
      .where(and(eq(commands.id, id), eq(commands.status, 'running')));
  }

  /** Killed by name — the agent's task_kill. Marked BEFORE the signal, so the
   *  stream's own exit (conditioned on running) cannot overwrite it. */
  async markKilled(id: string): Promise<void> {
    await this.finish(id, 'killed', null);
  }

  /** Session IDs (among `candidates`) that have at least one running command.
   *  Used by the idle reaper — a session with a live command is not idle. */
  async sessionsWithRunning(candidates: string[]): Promise<Set<string>> {
    if (!candidates.length) return new Set();
    const rows = await this.db.select({ sessionId: commands.sessionId }).from(commands)
      .where(and(inArray(commands.sessionId, candidates), eq(commands.status, 'running')));
    return new Set(rows.map((r) => r.sessionId));
  }

  /** Killed by sid — the /tasks screen. Returns the row marked, if one was
   *  running under that sid in this session. */
  async markKilledBySid(sessionId: string, sid: string): Promise<string | null> {
    const marked = await this.db.update(commands)
      .set({ status: 'killed', endedAt: new Date() })
      .where(and(eq(commands.sessionId, sessionId), eq(commands.sid, sid), eq(commands.status, 'running')))
      .returning({ id: commands.id });
    return marked[0]?.id ?? null;
  }
}
