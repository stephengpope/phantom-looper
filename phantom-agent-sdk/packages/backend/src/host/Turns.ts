// Turns — a turn driven on a session runner, as the backend places one.
// Two doors, one dispatch:
//
//   place    a session nobody holds (a cron's fresh session, a card run's
//            seat): the hold is taken FOR the runner, then the job goes.
//   handoff  a turn someone holds (Agent.disconnect, at a step boundary):
//            the hold MOVES to the runner, then the job goes.
//
// Either way the runner's agent finds the hold already its own at its
// turn-start, the record whole, and calls the model next (client
// `Agent.continueTurn`). The turn streams on the session feed like any
// driver's; this object hears only the job's end. A job that fails before
// its agent ever took the session leaves the hold with nobody behind it:
// released here, so the session is free.
//
// Placement is the runner's hello: an online runner that drives the agent
// type (HostFacts.agents), in the workspace tiers. None → `no_runner`, and
// the caller drives the turn itself (the API's engines) or carries on (a
// hand-off refused). The kits a turn needs (a card run's board powers) ride
// the job by name with their arguments; the runner builds them from what
// its app registered beside the agents.
import type { ProjectRow, SessionRow } from '../storage/schema.js';
import type { Sessions } from '../storage/Sessions.js';
import type { Settings } from '../storage/Settings.js';
import type { SessionEvents } from '../agents/SessionEvents.js';
import type { Runners } from './Runners.js';
import type { Job, TurnJobResult } from './protocol.js';
import { scopeOf } from '../lib/scopes.js';
import { logger, errStr } from '../lib/log.js';

const log = logger('turns');

/** What a turn is, apart from where it runs: the agent, its opening words,
 *  who drives it and for whom, the kits it needs. */
export type TurnSpec = Omit<Extract<Job, { type: 'turn' }>, 'id' | 'type' | 'sessionId'>;

/** A turn placed on a runner: who took it, and how it ended when it does. */
export interface PlacedTurn { runner: { id: string; name: string }; result: Promise<TurnJobResult> }

export class Turns {
  constructor(
    private readonly sessions: Sessions,
    private readonly runners: Runners,
    private readonly settings: Settings,
    private readonly events: SessionEvents,
  ) {}

  /** Start `spec` on a runner for a session nobody holds. `locked`: someone
   *  does (the caller's rule: skip, wait for the release). */
  async place(session: SessionRow, project: ProjectRow, spec: TurnSpec): Promise<PlacedTurn | 'no_runner' | 'locked'> {
    const runner = await this.runners.placeTurn(spec.actingFor.userId ?? null, spec.agentType);
    if (!runner) return 'no_runner';
    const expires = await this.sessions.acquireLock(session, runner.id, await this.#ttl(project), runner.name);
    if (!expires) return 'locked';
    return this.#dispatch(session, runner, spec, expires, 'placed');
  }

  /** Move `from`'s held turn to a runner. `lost`: `from` no longer held it. */
  async handoff(session: SessionRow, project: ProjectRow, from: string, spec: TurnSpec): Promise<PlacedTurn | 'no_runner' | 'lost'> {
    const runner = await this.runners.placeTurn(spec.actingFor.userId ?? null, spec.agentType);
    if (!runner) return 'no_runner';
    const expires = await this.sessions.transferLock(session.id, from, runner.id, runner.name, await this.#ttl(project));
    if (!expires) return 'lost';
    return this.#dispatch(session, runner, spec, expires, `handed off from ${from}`);
  }

  async #ttl(project: ProjectRow): Promise<number> {
    return Number((await this.settings.resolveMany(['session_lock_ttl_ms'], scopeOf(project))).session_lock_ttl_ms);
  }

  #dispatch(session: SessionRow, runner: { id: string; name: string; turn(spec: TurnSpec & { sessionId: string }): Promise<TurnJobResult> },
    spec: TurnSpec, expires: Date, how: string): PlacedTurn {
    this.events.publish(session.id, runner.id, { event: 'lock', locked: true, by: runner.id, label: runner.name,
      agent: session.agent ?? null, expires_at: expires.toISOString() });
    log.info({ session: session.id, runner: runner.name, agent: spec.agentType, opening: spec.opening.length, how }, 'turn placed on a runner');
    const result = runner.turn({ ...spec, sessionId: session.id });
    result.then(
      (ended) => log.info({ session: session.id, runner: runner.name, outcome: ended.outcome }, 'placed turn finished'),
      async (error: unknown) => {
        log.warn({ session: session.id, runner: runner.name, err: errStr(error) }, 'placed turn failed');
        const now = await this.sessions.get(session.id).catch(() => undefined);
        if (now && now.lockedBy === runner.id) {
          if (await this.sessions.releaseLock(session.id, runner.id)) {
            this.events.publish(session.id, runner.id, { event: 'lock', locked: false, by: null, label: null, agent: session.agent ?? null, expires_at: null });
          }
        }
      });
    return { runner: { id: runner.id, name: runner.name }, result };
  }
}
