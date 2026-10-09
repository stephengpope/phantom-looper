// The cron scheduler — shockwave's, with the database as the source instead
// of cron.json. One croner job per cron row, held in memory, fires at its
// exact time (`protect: true` — a cron never overlaps itself). Croner
// computes the next fire forward from registration, so a slot that passed
// while the server was down never fires.
//
// Registrations follow the rows by EVENTS, not polling (shockwave polls
// because its file lives on GitHub; ours is written in this process): boot
// registers everything once; every write to the table (Crons.subscribe) and
// every settings write (a project's cron switch or zone) reconciles that
// project — NON-DESTRUCTIVELY: only a changed schedule or zone
// re-registers, running jobs are left alone, rows that are gone are dropped.
// Reconciles are queued one after another, so two can never see the same
// row as new and register it twice.
//
// A fire opens a NEW coding session in the project (its own checkout,
// named after the cron, opened by the cron actor), runs the prompt as one
// coding turn on the client SDK — the same agent a cli window runs — and
// closes it. A cron that names its model stamps it on that session's row
// first (Sessions.stampModel), so the run reads the row like every runner
// and the record shows what ran; its reasoning rides the pin. A SCRIPT cron
// runs `sh <path>` instead, through the same bash
// tool route the agent's own bash calls (one executor: pidfile, interrupt,
// timeout, output tail), with no model in the loop — zero tokens. Either
// way the session is the run's record: a script run saves a two-message
// transcript (the command, its exit code and output) so /resume reads it
// like any other run. A script failure is logged and recorded, not
// announced. A one-time cron's row is
// deleted when it fires (the next refresh drops its registration); a
// recurring one records the time. A one-time cron whose moment has already
// passed — the server slept through it — can never fire: its row is deleted
// at reconcile rather than listed as if it were still coming.
//
// Like a card run, this is a headless client of the backend's own HTTP
// surface over loopback; the database is reached only through the
// backend's objects. Each run is the cron's OWNER's: its client names the
// project's organization and the user who made the cron (x-phantom-*), so
// the run sees only that organization's rows and resolves that user's keys
// first — a scheduled run is theirs exactly as a turn they typed would be.
//
// The SDK's: the app hands it the agent a prompt cron runs
// (PhantomBackendConfig.crons.agent) and nothing else.
import { Cron } from 'croner';
import { BackendClient, type Agent, type AgentHandlers } from '@phantom-agent-sdk/client';
import { messageLine, userMessage, assistantMessage } from '@phantom-agent-sdk/client/transcript';
import type { PhantomBackend } from '../PhantomBackend.js';
import type { CronRow } from '../storage/schema.js';
import { logger, errStr } from '../lib/log.js';
import { scopeOf } from '../lib/scopes.js';

/** The agent a prompt cron runs: its sessions are opened and resumed with
 *  these (an Agent subclass — the app's coding agent, say). */
export interface CronAgent {
  newSession(backend: BackendClient, handlers: AgentHandlers, projectId: string): Promise<Agent>;
  resumeSession(backend: BackendClient, handlers: AgentHandlers, sessionId: string): Promise<Agent>;
}

/** The cron scheduler's client id — its lock identity on the sessions it runs. */
export const CRON_CLIENT_ID = 'cron';
/** The cron scheduler as an actor — what its sessions record as started_by
 *  and last_turn_by; a default session list leaves those out (config.backgroundStarters). */
export const CRON_STARTER = 'cron';
const log = logger('cron');
/** A script's own timeout. The bash tool's default (`bash_timeout_ms`, two
 *  minutes) is sized for an agent waiting on a command; a nightly job is
 *  not. `bash_timeout_max_ms`, when set, still caps this. */
const SCRIPT_TIMEOUT_MS = 60 * 60 * 1000;

/** A registration. The zone is part of it, not just the schedule: the same
 *  string is a different instant in a different zone, so a zone change
 *  must re-register. */
interface Registration { cron: Cron; projectId: string; schedule: string; timezone: string }

export class CronScheduler {
  private registered = new Map<number, Registration>();   // cron row id → croner job
  private queue: Promise<void> = Promise.resolve();       // reconciles run one after another
  private unsubscribe: Array<() => void> = [];
  /** The agents with a run in flight, by session id. */
  private agents = new Map<string, Agent>();

  /** On the backend's objects: the cron rows, the projects (zone, switch),
   *  the sessions a run opens, and the settings feed (a project's cron
   *  switch or timezone moved). `agent`: what a prompt cron runs. */
  constructor(private readonly backend: PhantomBackend, private readonly agent: CronAgent) {}

  /** The client a run is made through: the scheduler's lock identity,
   *  acting for the cron's owner. */
  #clientFor(organizationId: string, userId: string | null): BackendClient {
    return new BackendClient({ url: this.backend.loopback.url, credential: { serviceRoleKey: this.backend.loopback.serviceRoleKey },
      clientId: CRON_CLIENT_ID, label: 'cron', actor: CRON_STARTER, actingFor: { organizationId, ...(userId ? { userId } : {}) } });
  }

  /** Boot: register everything once, then follow the writes. */
  start(): void {
    this.reconcile();
    this.unsubscribe.push(this.backend.crons.subscribe((projectId) => this.reconcile(projectId)));
    // A settings write names its scope: one project, or global — which
    // may be the switch or the zone every project inherits.
    this.unsubscribe.push(this.backend.settingsEvents.subscribe((change) => {
      const projectId = change.scope.startsWith('project:') ? change.scope.slice('project:'.length) : undefined;
      if (projectId || change.scope === 'global') this.reconcile(projectId);
    }));
    log.info('cron scheduler started');
  }

  stop(): void {
    for (const unsubscribe of this.unsubscribe) unsubscribe();
    this.unsubscribe = [];
    for (const registration of this.registered.values()) registration.cron.stop();
    this.registered.clear();
  }

  /** Bring one project's (or every) registration in line with its rows.
   *  Queued: reconciles never overlap. Nothing rejects upward. */
  reconcile(projectId?: string): void {
    this.queue = this.queue
      .then(() => this.reconcileNow(projectId))
      .catch((error) => log.error({ project: projectId, err: errStr(error) }, 'cron reconcile failed'));
  }

  /** Register new and changed crons, leave unchanged ones alone (a running
   *  job is never touched), drop what is gone, disabled, or switched off. */
  private async reconcileNow(projectId?: string): Promise<void> {
    const rows = await this.backend.crons.listEnabled(projectId);
    const seen = new Set<number>();
    const zones = new Map<string, { enabled: boolean; timezone: string }>();
    for (const row of rows) {
      let zone: { enabled: boolean; timezone: string } | undefined = zones.get(row.project_id);
      if (!zone) {
        const project = await this.backend.projects.get(row.project_id);
        if (!project) continue;
        try {
          const values = await this.backend.settings.resolveMany(['cron_enabled', 'timezone'], scopeOf(project));
          zone = { enabled: values.cron_enabled === true, timezone: String(values.timezone) };
        } catch (error) {
          log.error({ project: project.name, err: errStr(error) }, 'could not read the project\'s cron settings — its crons are not scheduled');
          continue;
        }
        zones.set(row.project_id, zone);
      }
      if (!zone.enabled) continue;   // the project's master switch: its registrations drop below
      seen.add(row.id);
      const existing = this.registered.get(row.id);
      if (existing && existing.schedule === row.schedule && existing.timezone === zone.timezone) continue;
      if (existing) existing.cron.stop();   // schedule or zone changed → replace
      try {
        // AWAITED on purpose: croner's `protect` holds only while it awaits
        // this callback, so a fire-and-forget body would let a long run
        // overlap itself. `fire` catches everything, so awaiting it cannot
        // reject into croner.
        const cron = new Cron(row.schedule, { timezone: zone.timezone, protect: true }, async () => {
          await this.fire(row.id);
        });
        if (!cron.nextRun()) {
          // A one-time cron whose moment has passed (the server slept
          // through it) can never fire: not a cron any more.
          cron.stop();
          seen.delete(row.id);
          if (row.once) {
            log.warn({ cron: row.name }, 'one-time cron missed its moment while the server was down — removed');
            await this.backend.crons.removeById(row.id);
          }
          continue;
        }
        this.registered.set(row.id, { cron, projectId: row.project_id, schedule: row.schedule, timezone: zone.timezone });
        log.info({ cron: row.name, next: cron.nextRun()?.toISOString() }, 'cron scheduled');
      } catch (error) {
        log.warn({ cron: row.name, schedule: row.schedule, err: errStr(error) }, 'invalid cron schedule — not scheduled');
      }
    }
    // Drop registrations (in scope) whose row vanished, was disabled, or
    // whose project was switched off.
    for (const [id, reg] of this.registered) {
      if (projectId && reg.projectId !== projectId) continue;
      if (!seen.has(id)) { reg.cron.stop(); this.registered.delete(id); }
    }
  }

  /** One fire. The row is re-read — its prompt may have been edited since
   *  registration — and marked fired first (a one-time cron's row goes),
   *  then run. Never throws: croner's protect is holding this. */
  private async fire(id: number): Promise<void> {
    let row: CronRow | undefined;
    try {
      row = await this.backend.crons.byId(id);
      if (!row) { this.registered.get(id)?.cron.stop(); this.registered.delete(id); return; }
      await this.backend.crons.markFired(row);
      if (row.once) { this.registered.get(id)?.cron.stop(); this.registered.delete(id); }
      await this.run(row);
    } catch (error) {
      log.error({ cron: row?.name ?? id, err: errStr(error) }, 'cron fire failed');
    }
  }

  private async run(row: CronRow): Promise<void> {
    const { sessions } = this.backend;
    let agent: Agent | undefined;
    try {
      const project = await this.backend.projects.get(row.project_id);
      if (!project) throw new Error(`project ${row.project_id} is gone`);
      const client = this.#clientFor(project.organizationId, row.user_id);
      log.info({ project: project.name, cron: row.name }, 'cron run started');
      const handlers: AgentHandlers = {
        onError: (error) => log.warn({ cron: row.name, code: error.code, err: error.message }, 'cron agent error'),
        onNotice: (notice) => log.info({ cron: row.name, type: notice.type }, notice.text),
      };
      // A fresh session, with its checkout, named after the cron, pinned to
      // the cron's model when it names one. The agent is resumed AFTER the
      // pin lands so its first turn-start reads it.
      const born = await this.agent.newSession(client, handlers, project.id);
      const sessionId = born.session.id;
      await born.close();
      await sessions.nameIfUnnamed(sessionId, row.name);
      if (row.provider && row.model) await sessions.stampModel(sessionId, { provider: row.provider, model: row.model, reasoning: row.reasoning });
      agent = await this.agent.resumeSession(client, handlers, sessionId);
      this.agents.set(sessionId, agent);
      if (row.script) {
        const exit = await this.runScript(client, agent, row.script);
        log.info({ project: project.name, cron: row.name, session: sessionId, script: row.script, exit }, 'cron script finished');
      } else {
        const result = await agent.sendMessage(row.prompt ?? '');
        log.info({ project: project.name, cron: row.name, session: sessionId,
          tokens: result ? result.usage.input + result.usage.output : 0, interrupted: result?.outcome === 'interrupted' }, 'cron run finished');
      }
    } catch (error) {
      // The session, when one opened, carries the error on its feed; this
      // line is the trace for a run that never got that far.
      log.warn({ cron: row.name, session: agent?.session.id, err: errStr(error) }, 'cron run failed');
    } finally {
      if (agent) {
        this.agents.delete(agent.session.id);
        await agent.close().catch((error) => log.warn({ cron: row.name, err: errStr(error) }, 'cron session did not close cleanly'));
      }
    }
  }

  /** `sh <script>` in the session's container, over the bash tool route.
   *  Whatever comes back — exit code, output, or the route's refusal (no
   *  such file, timeout) — is the record: appended to the session's record,
   *  never thrown. Returns the exit code, null when the command never ran. */
  private async runScript(client: BackendClient, agent: Agent, script: string): Promise<number | null> {
    const cmd = `sh ${shellQuote(script)}`;
    const sessionId = agent.session.id;
    // The run is a turn like any other: held for its duration (the record is
    // written under the hold), the hold let go at the end, always.
    await client.call('POST', `/sessions/${sessionId}/turn-start`, { type: agent.type, label: 'cron script' });
    try {
      const envelope = await client.callRaw<{ exitCode: number; stdout: string; stderr: string }>('POST', '/tools/bash',
        { cmd, timeout: SCRIPT_TIMEOUT_MS }, { sessionId });
      const exit = envelope.ok ? envelope.data.exitCode : null;
      const report = envelope.ok
        ? `exit ${envelope.data.exitCode}\n\n${envelope.data.stdout}${envelope.data.stderr ? `\n--- stderr ---\n${envelope.data.stderr}` : ''}`
        : `did not finish: ${envelope.error.message}${envelope.error.detail ? `\n\n${JSON.stringify(envelope.error.detail)}` : ''}`;
      await client.call('POST', `/sessions/${sessionId}/transcript/append`,
        { after: 0, deliveryId: `cron-${Date.now()}`, lines: [messageLine(userMessage(cmd)), messageLine(assistantMessage(report))] });
      return exit;
    } finally {
      await client.call('POST', `/sessions/${sessionId}/turn-ended`).catch(() => {});
    }
  }
}

/** Single-quote a path for sh — the one thing a path may not contain
 *  unescaped is a single quote. */
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}
