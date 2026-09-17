// The background_tasks row's one owner: every detached bash command a
// session runs — its argv, its log file, its container-namespace session id
// (sid) once captured, and how it ended. The status column's rule lives
// here: a row leaves 'running' exactly once. The kill from /tasks and the
// reconciler's 'exited' are final; a late stream teardown must not overwrite
// them, so every terminal write is conditioned on the row still running.
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { backgroundTasks } from './db/schema.js';

export type BackgroundTaskRow = typeof backgroundTasks.$inferSelect;
/** How a running task ends: on its own, by a kill, or because its
 *  container went away under it. */
export type BackgroundTaskEnd = 'exited' | 'killed' | 'orphaned';

export class BackgroundTasks {
  constructor(private readonly db: Db) {}

  async get(id: string): Promise<BackgroundTaskRow | undefined> {
    const rows = await this.db.select().from(backgroundTasks).where(eq(backgroundTasks.id, id));
    return rows[0];
  }

  /** The task, only if it belongs to this session — the agent's own view. */
  async getInSession(id: string, sessionId: string): Promise<BackgroundTaskRow | undefined> {
    const rows = await this.db.select().from(backgroundTasks)
      .where(and(eq(backgroundTasks.id, id), eq(backgroundTasks.sessionId, sessionId)));
    return rows[0];
  }

  /** A session's tasks, newest first. */
  async listForSession(sessionId: string, limit: number): Promise<BackgroundTaskRow[]> {
    return this.db.select().from(backgroundTasks)
      .where(eq(backgroundTasks.sessionId, sessionId))
      .orderBy(desc(backgroundTasks.startedAt)).limit(limit);
  }

  /** A detached command began: the row keeps the ORIGINAL argv — the shell
   *  wrapper that captures the sid is plumbing, not what the user ran. */
  async start(row: { id: string; sessionId: string; argv: string[]; logPath: string }): Promise<void> {
    await this.db.insert(backgroundTasks).values({ ...row, status: 'running' });
  }

  /** The process tree's session id landed (captured from the pidfile). */
  async setSid(id: string, sid: string): Promise<void> {
    await this.db.update(backgroundTasks).set({ sid }).where(eq(backgroundTasks.id, id));
  }

  /** The stream ended: how, and with what code. Only a running row takes it. */
  async finish(id: string, status: BackgroundTaskEnd, exitCode: number | null): Promise<void> {
    await this.db.update(backgroundTasks).set({ status, exitCode, endedAt: new Date() })
      .where(and(eq(backgroundTasks.id, id), eq(backgroundTasks.status, 'running')));
  }

  /** Killed by id — the agent's task_kill. Marked BEFORE the signal, so the
   *  stream's own exit (conditioned on running) cannot overwrite it. */
  async markKilled(id: string): Promise<void> {
    await this.finish(id, 'killed', null);
  }

  /** Session IDs (among `candidates`) that have at least one running task.
   *  Used by the idle reaper — a session with a live task is not idle. */
  async sessionsWithRunning(candidates: string[]): Promise<Set<string>> {
    if (!candidates.length) return new Set();
    const rows = await this.db.select({ sessionId: backgroundTasks.sessionId }).from(backgroundTasks)
      .where(and(inArray(backgroundTasks.sessionId, candidates), eq(backgroundTasks.status, 'running')));
    return new Set(rows.map((r) => r.sessionId));
  }

  /** Killed by sid — the /tasks screen. Returns the row marked, if one was
   *  running under that sid in this session. */
  async markKilledBySid(sessionId: string, sid: string): Promise<string | null> {
    const marked = await this.db.update(backgroundTasks)
      .set({ status: 'killed', endedAt: new Date() })
      .where(and(eq(backgroundTasks.sessionId, sessionId), eq(backgroundTasks.sid, sid), eq(backgroundTasks.status, 'running')))
      .returning({ id: backgroundTasks.id });
    return marked[0]?.id ?? null;
  }
}
