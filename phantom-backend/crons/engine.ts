// The cron scheduler — shockwave's, with the database as the source instead
// of cron.json. One croner job per cron row, held in memory, fires at its
// exact time (`protect: true` — a cron never overlaps itself). Croner
// computes the next fire forward from registration, so a slot that passed
// while the server was down never fires.
//
// Registrations follow the rows by EVENTS, not polling (shockwave polls
// because its file lives on GitHub; ours is written in this process): boot
// registers everything once; every write to the table (Crons.subscribe) and
// every settings write (a workspace's cron switch or zone) reconciles that
// workspace — NON-DESTRUCTIVELY: only a changed schedule or zone
// re-registers, running jobs are left alone, rows that are gone are dropped.
// Reconciles are queued one after another, so two can never see the same
// row as new and register it twice.
//
// A fire opens a NEW coding session in the workspace (its own checkout,
// named after the cron, its seat stamped 'cron'), runs the prompt as one
// coding turn — the same runner the looper and the /turn route use — and
// closes it. A SCRIPT cron runs `sh <path>` instead, through the same bash
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
// Like the looper, this is a headless client of the server's own HTTP
// surface (injectFetch); the database is reached only through the row
// owners it is handed.
import type { FastifyInstance } from 'fastify';
import { Cron } from 'croner';
import { CRON_CLIENT_ID, type Sessions } from '../sessions.js';
import type { Crons, CronRow } from '../crons.js';
import type { Workspaces } from '../workspaces.js';
import type { Settings } from '../settings.js';
import { openSession, type OpenedSession } from '../../core/session.js';
import { serializeTranscript } from '../../core/llm/transcript.js';
import { runCodingTurn } from '../looper/turn.js';
import { SESSION_HEADER } from '../api/sessionHeader.js';
import { sessionPin } from '../agentConfig.js';
import { injectFetch } from '../looper/injectFetch.js';
import type { SessionEvents } from '../api/sessionEvents.js';
import type { SettingsEvents } from '../api/settingsEvents.js';
import type { BackdoorQueue } from '../api/backdoor.js';
import { logger, errStr } from '../log.js';

const log = logger('cron');
const BASE = 'http://cron/api';
/** A script's own timeout. The bash tool's default (`bash_timeout_ms`, two
 *  minutes) is sized for an agent waiting on a command; a nightly job is
 *  not. `bash_timeout_max_ms`, when set, still caps this. */
const SCRIPT_TIMEOUT_MS = 60 * 60 * 1000;

export interface CronEngineDeps {
  crons: Crons;
  workspaces: Workspaces;
  settings: Settings;
  sessions: Sessions;
  app: FastifyInstance;
  apiKey: string;
  sessionEvents?: SessionEvents;
  /** Settings writes — a workspace's cron switch or zone moved. */
  settingsEvents?: SettingsEvents;
  /** Active turns by session id — the interrupt route aborts these. */
  activeTurns?: Map<string, AbortController>;
  backdoor?: BackdoorQueue;
  /** Test seam: the fetch every MODEL call uses. Production never sets it. */
  modelFetch?: typeof fetch;
}

/** A registration. The zone is part of it, not just the schedule: the same
 *  string is a different instant in a different zone, so a zone change
 *  must re-register. */
interface Registration { cron: Cron; workspaceId: string; schedule: string; timezone: string }

export class CronEngine {
  private registered = new Map<number, Registration>();   // cron row id → croner job
  private queue: Promise<void> = Promise.resolve();       // reconciles run one after another
  private unsubscribe: Array<() => void> = [];
  private f: typeof fetch;

  constructor(private deps: CronEngineDeps) {
    this.f = injectFetch(deps.app);
  }

  /** Boot: register everything once, then follow the writes. */
  start(): void {
    this.reconcile();
    this.unsubscribe.push(this.deps.crons.subscribe((workspaceId) => this.reconcile(workspaceId)));
    // A settings write names its scope: one workspace, or global — which
    // may be the switch or the zone every workspace inherits.
    if (this.deps.settingsEvents) {
      this.unsubscribe.push(this.deps.settingsEvents.subscribe((e) => {
        const ws = e.scope.startsWith('workspace:') ? e.scope.slice('workspace:'.length) : undefined;
        if (ws || e.scope === 'global') this.reconcile(ws);
      }));
    }
    log.info('cron scheduler started');
  }

  stop(): void {
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
    for (const r of this.registered.values()) r.cron.stop();
    this.registered.clear();
  }

  /** Bring one workspace's (or every) registration in line with its rows.
   *  Queued: reconciles never overlap. Nothing rejects upward. */
  reconcile(workspaceId?: string): void {
    this.queue = this.queue
      .then(() => this.reconcileNow(workspaceId))
      .catch((e) => log.error({ workspace: workspaceId, err: errStr(e) }, 'cron reconcile failed'));
  }

  /** Register new and changed crons, leave unchanged ones alone (a running
   *  job is never touched), drop what is gone, disabled, or switched off. */
  private async reconcileNow(workspaceId?: string): Promise<void> {
    const rows = await this.deps.crons.listEnabled(workspaceId);
    const seen = new Set<number>();
    const zones = new Map<string, { enabled: boolean; timezone: string }>();
    for (const row of rows) {
      let ws = zones.get(row.workspace_id);
      if (!ws) {
        const w = await this.deps.workspaces.get(row.workspace_id);
        if (!w) continue;
        try {
          const s = await this.deps.settings.resolveMany(['cron_enabled', 'timezone'], { workspace: w });
          ws = { enabled: s.cron_enabled === true, timezone: s.timezone };
        } catch (e) {
          log.error({ workspace: w.name, err: errStr(e) }, 'could not read the workspace\'s cron settings — its crons are not scheduled');
          continue;
        }
        zones.set(row.workspace_id, ws);
      }
      if (!ws.enabled) continue;   // the workspace's master switch: its registrations drop below
      seen.add(row.id);
      const existing = this.registered.get(row.id);
      if (existing && existing.schedule === row.schedule && existing.timezone === ws.timezone) continue;
      if (existing) existing.cron.stop();   // schedule or zone changed → replace
      try {
        // AWAITED on purpose: croner's `protect` holds only while it awaits
        // this callback, so a fire-and-forget body would let a long run
        // overlap itself. `fire` catches everything, so awaiting it cannot
        // reject into croner.
        const cron = new Cron(row.schedule, { timezone: ws.timezone, protect: true }, async () => {
          await this.fire(row.id);
        });
        if (!cron.nextRun()) {
          // A one-time cron whose moment has passed (the server slept
          // through it) can never fire: not a cron any more.
          cron.stop();
          seen.delete(row.id);
          if (row.once) {
            log.warn({ cron: row.name }, 'one-time cron missed its moment while the server was down — removed');
            await this.deps.crons.removeById(row.id);
          }
          continue;
        }
        this.registered.set(row.id, { cron, workspaceId: row.workspace_id, schedule: row.schedule, timezone: ws.timezone });
        log.info({ cron: row.name, next: cron.nextRun()?.toISOString() }, 'cron scheduled');
      } catch (e) {
        log.warn({ cron: row.name, schedule: row.schedule, err: errStr(e) }, 'invalid cron schedule — not scheduled');
      }
    }
    // Drop registrations (in scope) whose row vanished, was disabled, or
    // whose workspace was switched off.
    for (const [id, reg] of this.registered) {
      if (workspaceId && reg.workspaceId !== workspaceId) continue;
      if (!seen.has(id)) { reg.cron.stop(); this.registered.delete(id); }
    }
  }

  /** One fire. The row is re-read — its prompt may have been edited since
   *  registration — and marked fired first (a one-time cron's row goes),
   *  then run. Never throws: croner's protect is holding this. */
  private async fire(id: number): Promise<void> {
    let row: CronRow | undefined;
    try {
      row = await this.deps.crons.byId(id);
      if (!row) { this.registered.get(id)?.cron.stop(); this.registered.delete(id); return; }
      await this.deps.crons.markFired(row);
      if (row.once) { this.registered.get(id)?.cron.stop(); this.registered.delete(id); }
      await this.run(row);
    } catch (e) {
      log.error({ cron: row?.name ?? id, err: errStr(e) }, 'cron fire failed');
    }
  }

  private async run(row: CronRow): Promise<void> {
    const { apiKey, sessions } = this.deps;
    let opened: OpenedSession | undefined;
    let sessionId: string | null = null;
    try {
      const w = await this.deps.workspaces.get(row.workspace_id);
      if (!w) throw new Error(`workspace ${row.workspace_id} is gone`);
      log.info({ workspace: w.name, cron: row.name }, 'cron run started');
      // A fresh session, with its checkout, named after the cron. The seat
      // is stamped before the turn so a window watching reads `cron` at
      // once; the transcript save re-derives it from the writer (CRON_CLIENT_ID).
      opened = await openSession({
        baseUrl: BASE, apiKey, clientId: CRON_CLIENT_ID, label: `cron: ${row.name}`,
        fetch: this.f, lock: true, workspaceId: w.id,
      });
      sessionId = opened.session.id;
      await sessions.nameIfUnnamed(sessionId, row.name);
      await sessions.stampAgent(sessionId, 'cron');
      this.deps.sessionEvents?.publish(sessionId, CRON_CLIENT_ID, { event: 'session', agent: 'cron' });

      const ac = new AbortController();
      this.deps.activeTurns?.set(sessionId, ac);
      try {
        if (row.script) {
          const exit = await this.runScript(opened, row.script, ac.signal);
          log.info({ workspace: w.name, cron: row.name, session: sessionId, script: row.script, exit }, 'cron script finished');
        } else {
          const deps = { f: this.f, apiKey, base: BASE, modelFetch: this.deps.modelFetch,
            sessionEvents: this.deps.sessionEvents, client: CRON_CLIENT_ID, backdoor: this.deps.backdoor,
            onRetry: (t: string) => log.warn({ cron: row.name }, t), signal: ac.signal };
          const t = await runCodingTurn(deps, opened, w.id, row.prompt ?? '', false,
            await this.deps.settings.agentConfig('coding', { workspace: w, pin: sessionPin(opened.session) }));
          log.info({ workspace: w.name, cron: row.name, session: sessionId, tokens: t.tokens, interrupted: t.interrupted }, 'cron run finished');
        }
      } finally {
        this.deps.activeTurns?.delete(sessionId);
      }
    } catch (e) {
      // The session, when one opened, carries the error on its feed; this
      // line is the trace for a run that never got that far.
      log.warn({ cron: row.name, session: sessionId, err: errStr(e) }, 'cron run failed');
    } finally {
      await opened?.close().catch((e) => log.warn({ cron: row.name, err: errStr(e) }, 'cron session did not close cleanly'));
    }
  }

  /** `sh <script>` in the session's container, over the bash tool route.
   *  Whatever comes back — exit code, output, or the route's refusal (no
   *  such file, timeout) — is the record: saved as the session's
   *  transcript, never thrown. Returns the exit code, null when the
   *  command never ran. */
  private async runScript(opened: OpenedSession, script: string, signal: AbortSignal): Promise<number | null> {
    const cmd = `sh ${shellQuote(script)}`;
    const r = await this.f(`${BASE}/tools/bash`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.deps.apiKey}`,
        [SESSION_HEADER]: opened.session.id },
      body: JSON.stringify({ cmd, timeout: SCRIPT_TIMEOUT_MS }),
      signal,
    });
    const j = await r.json() as { ok: true; data: { exitCode: number; stdout: string; stderr: string } }
      | { ok: false; error: { code: string; message: string; detail?: unknown } };
    const exit = j.ok ? j.data.exitCode : null;
    const report = j.ok
      ? `exit ${j.data.exitCode}\n\n${j.data.stdout}${j.data.stderr ? `\n--- stderr ---\n${j.data.stderr}` : ''}`
      : `did not finish: ${j.error.message}${j.error.detail ? `\n\n${JSON.stringify(j.error.detail)}` : ''}`;
    await opened.saveTranscript(serializeTranscript([
      { role: 'user', content: cmd },
      { role: 'assistant', content: report },
    ]));
    return exit;
  }
}

/** Single-quote a path for sh — the one thing a path may not contain
 *  unescaped is a single quote. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
