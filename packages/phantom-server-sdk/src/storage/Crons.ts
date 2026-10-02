// Crons — the crons table's one owner: a project's scheduled prompts or
// scripts, addressed by name. Writes notify the scheduler. Stub.
export interface CronRow {
  id: number; projectId: string; name: string; schedule: string; prompt: string | null; script: string | null;
  enabled: boolean; once: boolean; provider: string | null; model: string | null; reasoning: string | null;
  lastRunAt: Date | null; createdAt: Date;
}
export interface CronFields { name?: string; schedule?: string; prompt?: string | null; script?: string | null; enabled?: boolean; provider?: string | null; model?: string | null; reasoning?: string | null }

export class Crons {
  async list(projectId: string): Promise<CronRow[]> { throw stub(); }
  async byName(projectId: string, name: string): Promise<CronRow | undefined> { throw stub(); }
  async byId(id: number): Promise<CronRow | undefined> { throw stub(); }
  /** Enabled crons, all projects or one — the scheduler's input. */
  async listEnabled(projectId?: string): Promise<CronRow[]> { throw stub(); }
  async create(projectId: string, fields: CronFields & { name: string; schedule: string }): Promise<CronRow> { throw stub(); }
  async update(projectId: string, name: string, fields: CronFields): Promise<CronRow> { throw stub(); }
  async remove(projectId: string, name: string): Promise<void> { throw stub(); }
  /** A run fired: stamp it; a one-time cron is deleted. */
  async markFired(id: number, at?: Date): Promise<void> { throw stub(); }
  /** Hear a project's crons change (the scheduler subscribes). */
  onChange(listener: (projectId: string) => void): () => void { throw stub(); }
  /** Is this schedule a one-time ISO datetime rather than a cron expression? */
  static isOnce(schedule: string): boolean { throw stub(); }
  static nextFire(schedule: string, timezone: string, after: Date): Date | null { throw stub(); }
}
const stub = () => new Error('stub');
