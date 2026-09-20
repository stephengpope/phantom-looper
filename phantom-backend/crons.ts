// The cron row's one owner: a workspace's scheduled prompts (migration 037).
// This is the only file that queries the table, and the only place a
// schedule is checked — croner here is the same croner the scheduler
// (crons/engine.ts) fires with, so "is this valid" and "when does it fire"
// cannot disagree.
//
// Two kinds of cron. RECURRING: `schedule` is a cron expression and the row
// lives until removed. ONE-TIME (`once`): `schedule` is an ISO datetime — a
// reminder, a check-in later tonight — one moment ever; the row is deleted
// when it fires. `once` is decided here from the schedule's shape, never
// asked for.
import { and, eq, sql } from 'drizzle-orm';
import { Cron } from 'croner';
import { isUniqueViolation, type Db } from './db/client.js';
import { crons, type CronRow, type WorkspaceRow } from './db/schema.js';
import type { Clock } from '../core/clock.js';

export type { CronRow };

export class CronError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_args' | 'duplicate_name', message: string) { super(message); }
}

/** THE cron field list — create, update and the API schema all derive from it. */
export const CRON_FIELDS = ['name', 'schedule', 'prompt', 'enabled'] as const;
export type CronFields = Partial<{ name: string; schedule: string; prompt: string; enabled: boolean }>;

const NAME_MAX = 80;

/** A one-time schedule is a fixed moment, not a pattern: croner takes an ISO
 *  datetime as a pattern natively. A cron expression always has spaces in
 *  it and a datetime never does — that is the whole distinction. */
export const isOnce = (schedule: string): boolean => !schedule.includes(' ') && /^\d{4}-\d{2}-\d{2}/.test(schedule);

/** The schedule's first fire strictly after `after`, in `timezone`; null
 *  when it will never fire again (a datetime that has passed). Throws
 *  croner's own message for a schedule or zone it cannot read. */
export function nextFire(schedule: string, timezone: string, after: Date): Date | null {
  const c = new Cron(schedule, { timezone });
  try { return c.nextRun(after); }
  finally { c.stop(); }   // constructing a Cron starts a timer; nothing here wants one running
}

/** Refuse a schedule that does not parse or will never fire — written for
 *  the agent to act on, not to log. */
function checkSchedule(schedule: string, clock: Clock, now: Date): void {
  let fire: Date | null;
  try { fire = nextFire(schedule, clock.timezone, now); }
  catch (e) {
    throw new CronError('invalid_args',
      `"${schedule}" is not a valid schedule (${(e as Error).message}). Use a 5-field cron expression like ` +
      '"0 9 * * *", or an ISO datetime like "2026-03-14T18:50:00" for a one-time run.');
  }
  if (!fire) {
    throw new CronError('invalid_args', isOnce(schedule)
      ? `${schedule} has already passed (it is ${now.toISOString()} now), so this cron would never run. Pick a moment in the future.`
      : `"${schedule}" parses but will never fire again. Pick a schedule with upcoming runs.`);
  }
}

export class Crons {
  private listeners: Array<(workspaceId: string) => void> = [];
  constructor(private readonly db: Db) {}

  /** Hear every write, by workspace — the scheduler re-registers that
   *  workspace's crons on each. Events, not polling: the table is written
   *  only here, so here is where a change is known. */
  subscribe(fn: (workspaceId: string) => void): () => void {
    this.listeners.push(fn);
    return () => { this.listeners = this.listeners.filter((l) => l !== fn); };
  }
  private changed(workspaceId: string): void {
    for (const l of this.listeners) l(workspaceId);
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  /** A workspace's crons, by name. */
  async list(w: WorkspaceRow): Promise<CronRow[]> {
    return this.db.select().from(crons).where(eq(crons.workspace_id, w.id)).orderBy(crons.name);
  }

  /** The cron with this name (case-insensitive). */
  async byName(w: WorkspaceRow, name: string): Promise<CronRow | undefined> {
    const rows = await this.db.select().from(crons)
      .where(and(eq(crons.workspace_id, w.id), sql`lower(${crons.name}) = lower(${name})`));
    return rows[0];
  }

  /** Every enabled cron — what the scheduler registers, each in its
   *  workspace's zone. One workspace's, or all. */
  async listEnabled(workspaceId?: string): Promise<CronRow[]> {
    return this.db.select().from(crons)
      .where(and(eq(crons.enabled, true), workspaceId ? eq(crons.workspace_id, workspaceId) : undefined))
      .orderBy(crons.id);
  }

  /** The row behind a registration — re-read at fire time, so an edited
   *  prompt is what runs. Undefined once removed. */
  async byId(id: number): Promise<CronRow | undefined> {
    const rows = await this.db.select().from(crons).where(eq(crons.id, id));
    return rows[0];
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /** A new cron. Name, schedule and prompt required; the schedule must fire
   *  at least once from now, in the clock's zone. */
  async create(w: WorkspaceRow, fields: CronFields, clock: Clock, now = clock.now()): Promise<CronRow> {
    const name = cleanName(fields.name);
    const prompt = cleanPrompt(fields.prompt);
    const schedule = cleanSchedule(fields.schedule);
    checkSchedule(schedule, clock, now);
    try {
      const [row] = await this.db.insert(crons)
        .values({ workspace_id: w.id, name, schedule, once: isOnce(schedule), prompt,
          enabled: fields.enabled ?? true, created_at: now, updated_at: now })
        .returning();
      this.changed(w.id);
      return row;
    } catch (e) {
      if (isUniqueViolation(e)) throw new CronError('duplicate_name', `a cron named "${name}" already exists — update it, or pick another name`);
      throw e;
    }
  }

  /** Any subset of fields. A schedule change is checked like a create; a
   *  rename keeps the row. */
  async update(w: WorkspaceRow, name: string, fields: CronFields, clock: Clock, now = clock.now()): Promise<CronRow> {
    const set: Partial<typeof crons.$inferInsert> = {};
    if (fields.name !== undefined) set.name = cleanName(fields.name);
    if (fields.prompt !== undefined) set.prompt = cleanPrompt(fields.prompt);
    if (fields.schedule !== undefined) {
      set.schedule = cleanSchedule(fields.schedule);
      checkSchedule(set.schedule, clock, now);
      set.once = isOnce(set.schedule);
    }
    if (fields.enabled !== undefined) set.enabled = fields.enabled;
    if (!Object.keys(set).length) throw new CronError('invalid_args', 'no fields to update');
    const prior = await this.byName(w, name);
    if (!prior) throw new CronError('not_found', `no cron named "${name}" in this workspace`);
    try {
      const [row] = await this.db.update(crons).set({ ...set, updated_at: now }).where(eq(crons.id, prior.id)).returning();
      this.changed(w.id);
      return row;
    } catch (e) {
      if (isUniqueViolation(e)) throw new CronError('duplicate_name', `a cron named "${set.name}" already exists`);
      throw e;
    }
  }

  async remove(w: WorkspaceRow, name: string): Promise<boolean> {
    const prior = await this.byName(w, name);
    if (!prior) return false;
    await this.db.delete(crons).where(eq(crons.id, prior.id));
    this.changed(w.id);
    return true;
  }

  /** The scheduler's own removal — a one-time cron whose moment passed
   *  while the server was down can never fire and is not a cron any more.
   *  Not announced: the scheduler is the one listening. */
  async removeById(id: number): Promise<void> {
    await this.db.delete(crons).where(eq(crons.id, id));
  }

  /** It fired. A one-time cron has done the one thing it existed for — its
   *  row goes (the scheduler drops its registration); a recurring one
   *  records when. */
  async markFired(row: CronRow, at = new Date()): Promise<void> {
    if (row.once) { await this.db.delete(crons).where(eq(crons.id, row.id)); return; }
    await this.db.update(crons).set({ last_run_at: at }).where(eq(crons.id, row.id));
  }
}

function cleanName(v: unknown): string {
  const name = String(v ?? '').trim();
  if (!name) throw new CronError('invalid_args', 'a cron needs a name — it is how the cron is addressed');
  if (name.length > NAME_MAX) throw new CronError('invalid_args', `a cron name is at most ${NAME_MAX} characters`);
  return name;
}
function cleanPrompt(v: unknown): string {
  const prompt = String(v ?? '').trim();
  if (!prompt) {
    throw new CronError('invalid_args', 'a cron needs a prompt — what the run is asked to do. Make it self-contained: ' +
      'the run starts a fresh session that cannot see this conversation.');
  }
  return prompt;
}
function cleanSchedule(v: unknown): string {
  const schedule = String(v ?? '').trim();
  if (!schedule) {
    throw new CronError('invalid_args', 'a cron needs a schedule — a cron expression like "0 9 * * *", ' +
      'or an ISO datetime like "2026-03-14T18:50:00" for a one-time run');
  }
  return schedule;
}
