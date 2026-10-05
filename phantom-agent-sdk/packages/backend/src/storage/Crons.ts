// The cron row's one owner: a project's scheduled prompts (migration 037).
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
//
// Two bodies, exactly one set. `prompt`: an agent turn — tokens on every
// fire. `script`: a path in the checkout run with `sh`, no model — for
// what a shell script already does. Setting one on update clears the other;
// the pair is checked here and by the table (migration 040).
//
// The model, optionally. A run is a fresh coding session on the project's
// settings; `provider` + `model` (together, or neither — migration 042) pin
// one cron's runs to another model, `reasoning` sets how hard it thinks.
// Null = the project's. The provider must be one the project can call —
// the same rule the /settings picker uses (@phantom-agent-sdk/client keyedProviders): a key on
// /keys, or a provider that takes none. The scheduler (crons/engine.ts)
// lays them over the run's session (agentConfig.ts pinned).
import { and, eq, sql } from 'drizzle-orm';
import { Cron } from 'croner';
import { Database, type Drizzle } from './Database.js';
import { crons, type CronRow, type ProjectRow } from '../storage/schema.js';
import type { Clock } from '../lib/clock.js';
import { keyedProviders, REASONINGS } from '@phantom-agent-sdk/client';
import type { Settings } from './Settings.js';
import { scopeOf } from '../lib/scopes.js';

export type { CronRow };

export class CronError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_args' | 'duplicate_name', message: string) { super(message); }
}

/** THE cron field list — create, update and the API schema all derive from it. */
export const CRON_FIELDS = ['name', 'schedule', 'prompt', 'script', 'provider', 'model', 'reasoning', 'enabled'] as const;
export type CronFields = Partial<{
  name: string; schedule: string; prompt: string; script: string;
  provider: string | null; model: string | null; reasoning: string | null; enabled: boolean;
}>;

const NAME_MAX = 80;

/** A one-time schedule is a fixed moment, not a pattern: croner takes an ISO
 *  datetime as a pattern natively. A cron expression always has spaces in
 *  it and a datetime never does — that is the whole distinction. */
export const isOnce = (schedule: string): boolean => !schedule.includes(' ') && /^\d{4}-\d{2}-\d{2}/.test(schedule);

/** The schedule's first fire strictly after `after`, in `timezone`; null
 *  when it will never fire again (a datetime that has passed). Throws
 *  croner's own message for a schedule or zone it cannot read. */
export function nextFire(schedule: string, timezone: string, after: Date): Date | null {
  const cron = new Cron(schedule, { timezone });
  try { return cron.nextRun(after); }
  finally { cron.stop(); }   // constructing a Cron starts a timer; nothing here wants one running
}

/** Refuse a schedule that does not parse or will never fire — written for
 *  the agent to act on, not to log. */
function checkSchedule(schedule: string, clock: Clock, now: Date): void {
  let fire: Date | null;
  try { fire = nextFire(schedule, clock.timezone, now); }
  catch (error) {
    throw new CronError('invalid_args',
      `"${schedule}" is not a valid schedule (${(error as Error).message}). Use a 5-field cron expression like ` +
      '"0 9 * * *", or an ISO datetime like "2026-03-14T18:50:00" for a one-time run.');
  }
  if (!fire) {
    throw new CronError('invalid_args', isOnce(schedule)
      ? `${schedule} has already passed (it is ${now.toISOString()} now), so this cron would never run. Pick a moment in the future.`
      : `"${schedule}" parses but will never fire again. Pick a schedule with upcoming runs.`);
  }
}

export class Crons {
  private listeners: Array<(projectId: string) => void> = [];
  constructor(private readonly database: Drizzle, private readonly settings: Settings) {}

  /** Hear every write, by project — the scheduler re-registers that
   *  project's crons on each. Events, not polling: the table is written
   *  only here, so here is where a change is known. */
  subscribe(listener: (projectId: string) => void): () => void {
    this.listeners.push(listener);
    return () => { this.listeners = this.listeners.filter((listener) => listener !== listener); };
  }
  private changed(projectId: string): void {
    for (const listener of this.listeners) listener(projectId);
  }

  // ── reads ──────────────────────────────────────────────────────────────────

  /** A project's crons, by name. */
  async list(project: ProjectRow): Promise<CronRow[]> {
    return this.database.select().from(crons).where(eq(crons.project_id, project.id)).orderBy(crons.name);
  }

  /** The cron with this name (case-insensitive). */
  async byName(project: ProjectRow, name: string): Promise<CronRow | undefined> {
    const rows = await this.database.select().from(crons)
      .where(and(eq(crons.project_id, project.id), sql`lower(${crons.name}) = lower(${name})`));
    return rows[0];
  }

  /** Every enabled cron — what the scheduler registers, each in its
   *  project's zone. One project's, or all. */
  async listEnabled(projectId?: string): Promise<CronRow[]> {
    return this.database.select().from(crons)
      .where(and(eq(crons.enabled, true), projectId ? eq(crons.project_id, projectId) : undefined))
      .orderBy(crons.id);
  }

  /** The row behind a registration — re-read at fire time, so an edited
   *  prompt is what runs. Undefined once removed. */
  async byId(id: number): Promise<CronRow | undefined> {
    const rows = await this.database.select().from(crons).where(eq(crons.id, id));
    return rows[0];
  }

  // ── writes ─────────────────────────────────────────────────────────────────

  /** A new cron. Name, schedule and prompt required; the schedule must fire
   *  at least once from now, in the clock's zone. */
  async create(project: ProjectRow, fields: CronFields, clock: Clock, now = clock.now()): Promise<CronRow> {
    const name = cleanName(fields.name);
    const body = cleanBody(fields.prompt, fields.script);
    const schedule = cleanSchedule(fields.schedule);
    checkSchedule(schedule, clock, now);
    const model = await this.cleanModel(project, fields.provider, fields.model);
    const reasoning = cleanReasoning(fields.reasoning);
    try {
      const [row] = await this.database.insert(crons)
        .values({ project_id: project.id, name, schedule, once: isOnce(schedule), ...body, ...model, reasoning,
          enabled: fields.enabled ?? true, created_at: now, updated_at: now })
        .returning();
      this.changed(project.id);
      return row!;
    } catch (error) {
      if (Database.isUniqueViolation(error)) throw new CronError('duplicate_name', `a cron named "${name}" already exists — update it, or pick another name`);
      throw error;
    }
  }

  /** Any subset of fields. A schedule change is checked like a create; a
   *  rename keeps the row. */
  async update(project: ProjectRow, name: string, fields: CronFields, clock: Clock, now = clock.now()): Promise<CronRow> {
    const set: Partial<typeof crons.$inferInsert> = {};
    if (fields.name !== undefined) set.name = cleanName(fields.name);
    if (fields.prompt !== undefined || fields.script !== undefined) Object.assign(set, cleanBody(fields.prompt, fields.script));
    if (fields.schedule !== undefined) {
      set.schedule = cleanSchedule(fields.schedule);
      checkSchedule(set.schedule, clock, now);
      set.once = isOnce(set.schedule);
    }
    if (fields.provider !== undefined || fields.model !== undefined) Object.assign(set, await this.cleanModel(project, fields.provider, fields.model));
    if (fields.reasoning !== undefined) set.reasoning = cleanReasoning(fields.reasoning);
    if (fields.enabled !== undefined) set.enabled = fields.enabled;
    if (!Object.keys(set).length) throw new CronError('invalid_args', 'no fields to update');
    const prior = await this.byName(project, name);
    if (!prior) throw new CronError('not_found', `no cron named "${name}" in this project`);
    try {
      const [row] = await this.database.update(crons).set({ ...set, updated_at: now }).where(eq(crons.id, prior.id)).returning();
      this.changed(project.id);
      return row!;
    } catch (error) {
      if (Database.isUniqueViolation(error)) throw new CronError('duplicate_name', `a cron named "${set.name}" already exists`);
      throw error;
    }
  }

  async remove(project: ProjectRow, name: string): Promise<boolean> {
    const prior = await this.byName(project, name);
    if (!prior) return false;
    await this.database.delete(crons).where(eq(crons.id, prior.id));
    this.changed(project.id);
    return true;
  }

  /** The model pair: both or neither, on a provider this project can call.
   *  Both columns come back so a write of one (or a null) resets the pair —
   *  a provider with no model is nothing to run on, a model with no
   *  provider could be anyone's. */
  private async cleanModel(project: ProjectRow, rawProvider: unknown, rawModel: unknown): Promise<{ provider: string | null; model: string | null }> {
    const provider = String(rawProvider ?? '').trim();
    const model = String(rawModel ?? '').trim();
    if (!provider && !model) return { provider: null, model: null };
    if (!provider || !model) {
      throw new CronError('invalid_args', 'provider and model go together — give both to run this cron on another ' +
        'model, or neither (null) to run on the project\'s. A model id means nothing without its provider.');
    }
    const keyed = keyedProviders(await this.settings.layersForScope(scopeOf(project)));
    if (!keyed.includes(provider as never)) {
      throw new CronError('invalid_args', `"${provider}" is not a provider this project can call — one with a key on /keys: ` +
        `${keyed.join(', ')}. Save a key there first.`);
    }
    return { provider, model };
  }

  /** The scheduler's own removal — a one-time cron whose moment passed
   *  while the server was down can never fire and is not a cron any more.
   *  Not announced: the scheduler is the one listening. */
  async removeById(id: number): Promise<void> {
    await this.database.delete(crons).where(eq(crons.id, id));
  }

  /** It fired. A one-time cron has done the one thing it existed for — its
   *  row goes (the scheduler drops its registration); a recurring one
   *  records when. */
  async markFired(row: CronRow, at = new Date()): Promise<void> {
    if (row.once) { await this.database.delete(crons).where(eq(crons.id, row.id)); return; }
    await this.database.update(crons).set({ last_run_at: at }).where(eq(crons.id, row.id));
  }
}

function cleanName(value: unknown): string {
  const name = String(value ?? '').trim();
  if (!name) throw new CronError('invalid_args', 'a cron needs a name — it is how the cron is addressed');
  if (name.length > NAME_MAX) throw new CronError('invalid_args', `a cron name is at most ${NAME_MAX} characters`);
  return name;
}
/** The body: a prompt or a script, never both, never neither. Both columns
 *  come back so a write of one clears the other. */
function cleanBody(rawPrompt: unknown, rawScript: unknown): { prompt: string | null; script: string | null } {
  const prompt = String(rawPrompt ?? '').trim();
  const script = String(rawScript ?? '').trim();
  if (prompt && script) throw new CronError('invalid_args', 'a cron runs a prompt OR a script — give one, not both');
  if (!prompt && !script) {
    throw new CronError('invalid_args', 'a cron needs a prompt or a script. A prompt is what an agent run is asked to do — ' +
      'make it self-contained: the run starts a fresh session that cannot see this conversation. A script is a path in ' +
      'the repo, run with sh and no model.');
  }
  return { prompt: prompt || null, script: script || null };
}
function cleanReasoning(value: unknown): string | null {
  const reasoning = String(value ?? '').trim();
  if (!reasoning) return null;
  if (!(REASONINGS as readonly string[]).includes(reasoning)) {
    throw new CronError('invalid_args', `"${reasoning}" is not a reasoning level — one of: ${REASONINGS.join(', ')}`);
  }
  return reasoning;
}
function cleanSchedule(value: unknown): string {
  const schedule = String(value ?? '').trim();
  if (!schedule) {
    throw new CronError('invalid_args', 'a cron needs a schedule — a cron expression like "0 9 * * *", ' +
      'or an ISO datetime like "2026-03-14T18:50:00" for a one-time run');
  }
  return schedule;
}
