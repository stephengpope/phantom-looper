// CronScheduler — one croner job per enabled cron row, held in memory.
// At its time a job opens a NEW session of the type the cron names and
// runs the prompt (or the script) as one turn; a one-time cron is then
// deleted. Re-reads a project's rows when they change. Stub.
export class CronScheduler {
  start(): void { throw stub(); }
  stop(): void { throw stub(); }
  /** Bring the registered jobs in line with the rows (all projects or one). */
  reconcile(projectId?: string): void { throw stub(); }
}
const stub = () => new Error('stub');
