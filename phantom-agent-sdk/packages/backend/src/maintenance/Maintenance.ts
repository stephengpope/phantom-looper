// Maintenance — the server's upkeep, as named jobs on their own timers.
//
// A job keeps one kind of thing tidy and does nothing else: the containers,
// the images, the checkouts, the disk. The api decides — it holds the rows
// and the settings — and sends each box the work over the runner link. A
// job never runs on top of itself, never waits on another, and never fires
// at boot: its first run is one interval after start. `<name>_interval_ms`
// is its timer, read before every wait, so a change applies on the next one.
//
// Every run is recorded — when, how long, what it counted, or why it
// failed — and the routes (api/routes/maintenance.ts) list the jobs, show
// one, and run one now.
import type { Settings } from '../storage/Settings.js';
import { logger, errStr } from '../lib/log.js';

const log = logger('maintenance');

export interface MaintenanceJob {
  /** snake_case; `<name>_interval_ms` is its timer. */
  name: string;
  description: string;
  /** Where the work runs. */
  where: 'session runners' | 'api and session runners' | 'api';
  /** Do the work; answer what was done, as counts. */
  run(): Promise<Record<string, number>>;
}

export interface MaintenanceRun {
  startedAt: string;
  endedAt: string | null;
  ms: number | null;
  counts: Record<string, number>;
  error: string | null;
  /** Its timer, or a request to run now. */
  by: 'timer' | 'request';
}

export interface MaintenanceView {
  name: string;
  description: string;
  where: MaintenanceJob['where'];
  intervalMs: number;
  running: boolean;
  lastRun: MaintenanceRun | null;
}

export class MaintenanceError extends Error {
  constructor(readonly code: 'not_found' | 'running', message: string) { super(message); this.name = 'MaintenanceError'; }
}

/** When the interval setting cannot be read (the database is down): try again in a minute. */
const RETRY_MS = 60_000;

export class Maintenance {
  #stopped = false;
  readonly #running = new Map<string, Promise<MaintenanceRun>>();
  readonly #last = new Map<string, MaintenanceRun>();
  /** The sleeping loops' timers, cut short on stop. */
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(private readonly settings: Settings, private readonly jobs: readonly MaintenanceJob[]) {
    const names = new Set<string>();
    for (const job of jobs) {
      if (names.has(job.name)) throw new Error(`two maintenance jobs are named ${job.name}`);
      names.add(job.name);
    }
  }

  /** One loop per job: wait its interval, run, again — until stop. */
  start(): void {
    for (const job of this.jobs) void this.#loop(job);
    log.info({ jobs: this.jobs.map((job) => job.name) }, 'maintenance up');
  }

  /** No loop runs again; a run in progress finishes on its own. */
  stop(): void {
    this.#stopped = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
  }

  async list(): Promise<MaintenanceView[]> {
    return Promise.all(this.jobs.map((job) => this.#view(job)));
  }

  async get(name: string): Promise<MaintenanceView> {
    return this.#view(this.#job(name));
  }

  /** Run a job now, outside its timer. Refused while it is running. */
  run(name: string): Promise<MaintenanceRun> {
    const job = this.#job(name);
    if (this.#running.has(job.name)) throw new MaintenanceError('running', `${job.name} is running`);
    return this.#run(job, 'request');
  }

  #job(name: string): MaintenanceJob {
    const job = this.jobs.find((candidate) => candidate.name === name);
    if (!job) throw new MaintenanceError('not_found', `no maintenance job ${name}`);
    return job;
  }

  async #view(job: MaintenanceJob): Promise<MaintenanceView> {
    return { name: job.name, description: job.description, where: job.where, intervalMs: await this.#intervalMs(job),
      running: this.#running.has(job.name), lastRun: this.#last.get(job.name) ?? null };
  }

  async #intervalMs(job: MaintenanceJob): Promise<number> {
    const value = Number(await this.settings.resolve(`${job.name}_interval_ms`));
    if (!(value > 0)) throw new Error(`${job.name}_interval_ms is ${value}`);
    return value;
  }

  async #loop(job: MaintenanceJob): Promise<void> {
    while (!this.#stopped) {
      const wait = await this.#intervalMs(job).catch((error) => {
        log.warn({ job: job.name, err: errStr(error) }, 'could not read the interval — trying again in a minute');
        return RETRY_MS;
      });
      await this.#sleep(wait);
      if (this.#stopped) return;
      // A timer never runs a job on top of a requested run: it waits that one out.
      await (this.#running.get(job.name) ?? this.#run(job, 'timer'));
    }
  }

  #run(job: MaintenanceJob, by: MaintenanceRun['by']): Promise<MaintenanceRun> {
    const started = Date.now();
    const record: MaintenanceRun = { startedAt: new Date(started).toISOString(), endedAt: null, ms: null, counts: {}, error: null, by };
    const running = job.run()
      .then((counts) => { record.counts = counts; }, (error) => { record.error = errStr(error); })
      .then(() => {
        record.endedAt = new Date().toISOString();
        record.ms = Date.now() - started;
        this.#last.set(job.name, record);
        if (record.error) log.warn({ job: job.name, by, ms: record.ms, err: record.error }, 'maintenance job failed');
        else log.info({ job: job.name, by, ms: record.ms, ...record.counts }, 'maintenance job ran');
        return record;
      })
      .finally(() => { this.#running.delete(job.name); });
    this.#running.set(job.name, running);
    return running;
  }

  #sleep(ms: number): Promise<void> {
    return new Promise<void>((wake) => {
      const timer = setTimeout(() => { this.#timers.delete(timer); wake(); }, ms);
      this.#timers.add(timer);
    });
  }
}
