// The looper: the supervisor loop over kanban cards. User space, on the
// backend SDK's objects (cards, sessions, settings, the feeds) and the client
// SDK's agents over loopback — a card run is two agents, a coder and a
// supervisor, each a normal client of this backend's own API, holding its
// session like a cli window would.
//
// There is NO loop object and NO polling. Loop state = card status plus the
// two transcripts (logic.ts reads the next owed step off them). Every card
// write lands on the board bus; that is what runs the loop. A session's hold
// released by anyone but this engine re-runs its card's loop.
import { BackendClient, type AgentHandlers, type Agent } from 'phantom-client-sdk';
import { CodingAgent } from '../../core/agents/coding.js';
import { SupervisorAgent } from '../../core/agents/supervisor.js';
import type { ProjectRow } from 'phantom-backend-sdk/schema';
import { GLOBAL, type CardFields, type PhantomBackend } from 'phantom-backend-sdk';
import { logger, errStr } from 'phantom-backend-sdk';
import { canTurn, unsentKickoff, nextStep, needsFreshSession, LOOP_COLUMNS, type CardRow } from './logic.js';
import { codingAgentCardKit, supervisorCardKit, type LoopColumn } from './cardRunTools.js';

const log = logger('looper');
/** The card run's lock identity — the holder under which its coding and
 *  supervisor turns save. The looper locks with it when it starts a run, the
 *  release hook ignores it, and the auto-build alerts read the mover off it. */
export const LOOP_CLIENT_ID = 'supervisor';
const CLIENT_ID = LOOP_CLIENT_ID;
/** The looper as an actor — what its sessions record as started_by and
 *  last_turn_by; a default session list leaves those out (config.backgroundStarters). */
export const LOOPER_STARTER = 'looper';

/** What a turn did — the card run's chaining signal. `turn` means an agent
 *  turn ran and the next step is owed NOW; `moved`/`idle` mean the card was
 *  acted on or nothing was owed; `skipped` means a seat was held elsewhere —
 *  the lock's release re-runs the loop. */
export type TurnOutcome = 'turn' | 'moved' | 'idle' | 'skipped' | 'interrupted';

/** The chain's token spend: seeded once from the token API when the loop
 *  picks the card up, each turn's own numbers added as they land. The limit
 *  itself is a setting and is read again before every turn. */
interface Budget { seeded: boolean; spent: number }

export class LooperEngine {
  private stopped = false;
  private running = new Set<string>();          // projectId:cardNumber — one live loop per card
  private pending = new Set<string>();          // called while running — go again after
  /** The agents with a turn in flight, by session id — stop() interrupts them. */
  private agents = new Map<string, Agent>();
  /** One client, this engine's lock identity, for every agent it opens. */
  private readonly client: BackendClient;

  /** On the backend's objects: the board, the sessions, the settings, the
   *  token log (the budget's coin), and its three feeds — the board bus runs
   *  the loop, the settings feed re-examines a project when a loop switch
   *  moves, the session feed re-runs a card when a hold is released. */
  constructor(private readonly backend: PhantomBackend) {
    this.client = new BackendClient({ url: backend.loopback.url, apiKey: backend.loopback.apiKey, clientId: CLIENT_ID, label: 'card run', actor: LOOPER_STARTER });
  }

  /** What an agent this engine runs tells it: errors and notices go to the log. */
  private handlers(card: number, seat: 'coding' | 'supervisor'): AgentHandlers {
    return {
      onError: (error) => log.warn({ card, agent: seat, code: error.code, err: error.message }, 'agent error'),
      onNotice: (notice) => log.info({ card, agent: seat, type: notice.type }, notice.text),
    };
  }

  /** Boot: ONE recovery pass — cards that were mid-loop when the process
   *  died. After this, turns run on events only. */
  start(): void {
    // Every card write, from any door (a route, the Assistant, this engine
    // itself), lands on the board bus: that is what runs the loop. The engine
    // re-reads the row and checks canTurn, so an irrelevant edit is a no-op.
    this.backend.boardEvents.subscribeAll((projectId, e) => {
      if (e.event === 'card') void this.runLoop(projectId, Number((e.card as { number: number }).number));
    });
    // Supervision flipped (either switch, at any layer, through any door):
    // re-examine the affected project — every one when the global layer
    // moved. Event-driven, no poll.
    this.backend.settingsEvents.subscribe((e) => {
      if (!e.keys.some((k) => k === 'auto_plan' || k === 'auto_build')) return;
      const projectId = e.scope === GLOBAL ? undefined : e.scope.replace(/^project:/, '');
      void this.runAllLoops(projectId).catch((err) => log.warn({ err: errStr(err) }, 'looper settings pass failed'));
    });
    // A session let go of (its hold released, by anyone but this engine):
    // its card, if any, may be runnable again. The release is a `lock`
    // event on the session feed, published under the releasing client.
    this.backend.sessionEvents.subscribeAll((sessionId, e, by) => {
      if (e.event === 'lock' && e.locked === false) void this.runLoopOfSession(sessionId, by);
    });
    void this.runAllLoops().catch((e) => log.warn({ err: errStr(e) }, 'looper boot pass failed'));
  }
  stop(): void {
    this.stopped = true;
    for (const agent of this.agents.values()) agent.interrupt({ keepQueue: true });
  }
  /** Cards with a round in flight right now — what an api restart would
   *  interrupt (they resume after boot). GET /health carries it so callers can warn. */
  runningCount(): number { return this.running.size; }

  /** Run the loop on every card in a loop column, for one project (a
   *  supervision setting changed) or all of them (boot). `canTurn` is
   *  re-checked before every turn off fresh rows, so over-calling is harmless. */
  async runAllLoops(projectId?: string): Promise<void> {
    const one = projectId ? await this.backend.projects.get(projectId) : undefined;
    const rows = projectId ? (one ? [one] : []) : await this.backend.projects.list();
    for (const project of rows) {
      let cards: CardRow[];
      try {
        cards = await this.backend.cards.listInColumns(project, LOOP_COLUMNS);
      } catch (e) {
        // Its loops never start this sweep — a card sitting in plan or
        // in_progress with nothing happening; the log is the only trace.
        log.error({ project: project.id, err: (e as Error).message }, 'could not read the project\'s cards — its loops did not run');
        continue;
      }
      for (const card of cards) void this.runLoop(project.id, card.number);
    }
  }

  /** A released session lock is the one event a skipped turn waits on: if
   *  the session is on a card (either seat), that card's loop runs. The
   *  engine's OWN releases — every turn ends in one — are ignored, or each
   *  turn's cleanup would refire the turn it just finished. */
  async runLoopOfSession(sessionId: string, releasedBy: string): Promise<void> {
    if (releasedBy === CLIENT_ID) return;
    let card;
    try { card = await this.backend.cards.ofSession(sessionId); }
    catch (e) {
      log.error({ session: sessionId, err: (e as Error).message }, 'could not look up the session\'s card — its round did not run');
      return;
    }
    if (card) void this.runLoop(card.project_id, card.number);
  }

  /** THE entry: run turns on one card while `canTurn` holds. Re-entrant
   *  calls coalesce (`pending`); the loop never runs twice concurrently on one
   *  card. The card is re-read before every turn, so a status change ends
   *  the loop at the next check — this is also the no-op path for every card
   *  write that changes nothing loop-shaped. A turn that throws blocks the
   *  card with the reason — the failure lands on the board and the loop is
   *  over; nothing retries a failed turn. */
  async runLoop(projectId: string, cardNumber: number): Promise<void> {
    const claim = `${projectId}:${cardNumber}`;
    if (this.running.has(claim)) { this.pending.add(claim); return; }
    this.running.add(claim);
    // One ledger per loop: seeded on the first turn that needs it, carried
    // across the turns, dropped when the loop ends.
    const budget: Budget = { seeded: false, spent: 0 };
    // Called fire-and-forget from routes: nothing here may reject upward.
    // Every path falls through to the while check, so a call that lands
    // mid-turn (`pending`) is honored — except stop, which ends everything.
    try {
      do {
        this.pending.delete(claim);
        if (this.stopped) return;

        // Fresh rows, then canTurn. Anything else — no card, wrong column,
        // switch off, a failed read — and there is no next turn.
        let project: ProjectRow | undefined;
        let card: CardRow | undefined;
        try {
          project = await this.backend.projects.get(projectId);
          if (!project) continue;
          const auto = await this.backend.settings.resolveMany(['auto_plan', 'auto_build'], { projectId: project.id })
            .catch(() => ({ auto_plan: false, auto_build: false }));
          card = await this.backend.cards.activeByNumber(project, cardNumber);
          if (!card || !canTurn(card, { plan: Boolean(auto.auto_plan), build: Boolean(auto.auto_build) })) continue;
        } catch (e) {
          log.warn({ card: cardNumber, err: errStr(e) }, 'looper could not read the card');
          continue;
        }

        let outcome: TurnOutcome;
        try {
          outcome = await this.runTurn(project, card, budget);
        } catch (e) {
          log.warn({ project: project.name, card: cardNumber, err: errStr(e) },
            'looper turn failed — blocking the card');
          await this.blockCard(project, card.number, errStr(e)).catch((be) =>
            log.error({ card: cardNumber, err: errStr(be) }, 'could not block the failed card'));
          continue;
        }
        // A turn just ran — the next step is owed now, not on the next
        // external event. (A status tool's card write re-enters through the
        // board bus too; `pending` catches that as well.)
        if (outcome === 'turn') this.pending.add(claim);
      } while (this.pending.has(claim));
    } finally {
      this.running.delete(claim);
    }
  }

  /** Fail closed: the turn's error becomes the card's blocked_reason — the
   *  board says WHY, and blocked is not a loop column, so the loop ends. */
  private async blockCard(project: ProjectRow, cardNumber: number, reason: string): Promise<void> {
    await this.patchCard(project, cardNumber, {
      status: 'blocked', blocked_reason: `looper turn failed: ${reason}`, resolution: null,
    });
  }

  /** A new supervisor session for the card: a conversation on the coder's
   *  workspace (the type borrows), opened by the looper, put on the card. */
  private async newSupervisor(project: ProjectRow, card: CardRow, coderSessionId: string): Promise<string> {
    const sup = await this.backend.sessions.start(project.id, SupervisorAgent.systemPromptLayout,
      { type: 'supervisor', startedBy: LOOPER_STARTER, workspaceSessionId: coderSessionId });
    await this.backend.sessions.setCard(sup.id, card.id);
    return sup.id;
  }

  /** One turn for one card: open the CODING agent on its session, then do
   *  the ONE owed step — a kickoff, a supervisor turn (the coder's reply
   *  copied in), a delivery (the supervisor's reply out), or the return
   *  message. Two sessions, one record each: the coder's is the work, the
   *  supervisor's is its side of the dialogue. The supervisor holds no
   *  checkout — its read-only tools open the coder's workspace; its board
   *  powers are bound to THE card. Throws on failure — runLoop turns that
   *  into a blocked card. */
  async runTurn(project: ProjectRow, card: CardRow, budget: Budget): Promise<TurnOutcome> {
    // The card's coder — its newest coding session (Sessions.coderOf).
    const coder = await this.backend.sessions.coderOf(project.id, card.number);
    // Entering plan is a NEW run, always — the revision history is the
    // transition clock (logic.ts).
    const fresh = needsFreshSession(card.status, coder?.createdAt ?? null,
      await this.backend.cards.lastMovedAt(project, card.number));

    let codingAgent: CodingAgent;
    let supervisorSessionId: string;
    if (coder && !fresh) {
      codingAgent = await CodingAgent.resumeSession(this.client, this.handlers(card.number, 'coding'), coder.id);
      // The supervisor: born for THIS coder. One older than the coder
      // belonged to an earlier run — a fresh one is made.
      const sup = await this.backend.sessions.newestOnCard(project.id, card.number, 'supervisor');
      supervisorSessionId = sup && sup.createdAt.getTime() >= coder.createdAt.getTime()
        ? sup.id
        : await this.newSupervisor(project, card, coder.id);
    } else {
      // A new run: the coder (with its workspace), put on the card the moment it exists.
      codingAgent = await CodingAgent.newSession(this.client, this.handlers(card.number, 'coding'), project.id);
      const sessionId = codingAgent.session.id;
      await this.backend.sessions.setCard(sessionId, card.id);
      // The coder's session is named after its card from birth — /resume
      // never shows a nameless row while the first (long) plan turn runs.
      await this.backend.sessions.nameIfUnnamed(sessionId, card.title);
      this.backend.boardEvents.publish(project.id, { event: 'session', card: card.number, id: sessionId, name: card.title });
      // A new coder gets a new supervisor: a conversation on the coder's workspace, on the same card.
      supervisorSessionId = await this.newSupervisor(project, card, sessionId);
    }

    // ── the token budget — seeded once per loop, checked before every turn,
    // each turn's own numbers added as they land. Breach is a card state a
    // human can see, like every other loop exit. ──────────────────────────
    const b = await this.backend.settings.resolveMany(['loop_budget_tokens'], { projectId: project.id })
      .catch(() => ({ loop_budget_tokens: null }));
    const limit = b.loop_budget_tokens == null ? null : Number(b.loop_budget_tokens);
    if (!budget.seeded) {
      if (limit != null) budget.spent = await this.tokensOf(codingAgent.session.id) + await this.tokensOf(supervisorSessionId);
      budget.seeded = true;
    }
    if (limit != null && budget.spent >= limit) {
      await this.patchCard(project, card.number, {
        status: 'blocked', blocked_reason: `token budget exhausted: ${budget.spent} of ${limit} tokens used`, resolution: null,
      });
      log.info({ card: card.number, spent: budget.spent, limit }, 'looper budget exhausted');
      return 'moved';
    }

    const runCard = { projectId: project.id, number: card.number };
    codingAgent.addToolKit(codingAgentCardKit(runCard));

    // A session held elsewhere: `sendMessage` rejects session_locked and
    // nothing is recorded — the lock's release re-runs the loop.
    const run = async (agent: Agent, text: string): Promise<TurnOutcome | 'locked'> => {
      this.agents.set(agent.session.id, agent);
      try {
        const result = await agent.sendMessage(text);
        if (!result) return 'turn';
        budget.spent += result.usage.input + result.usage.output;
        return result.outcome === 'interrupted' ? 'interrupted' : 'turn';
      } catch (error) {
        if ((error as { code?: string }).code === 'session_locked') return 'locked';
        throw error;
      } finally {
        this.agents.delete(agent.session.id);
        await agent.close();
      }
    };
    const skippedIfLocked = (outcome: TurnOutcome | 'locked', seat: string): TurnOutcome => {
      if (outcome !== 'locked') return outcome;
      log.info({ card: card.number }, `${seat} session held elsewhere — skipped; the lock release will re-run the loop`);
      return 'skipped';
    };

    const opener = unsentKickoff(card, codingAgent.session.messages);
    if (opener) {
      await this.setPlanMode(codingAgent.session.id, opener.planMode);
      return skippedIfLocked(await run(codingAgent, opener.text), 'card');
    }

    const supervisor = await SupervisorAgent.resumeSession(this.client, this.handlers(card.number, 'supervisor'), supervisorSessionId);
    const step = nextStep(card, codingAgent.session.messages, supervisor.session.messages);
    if (!step) { await codingAgent.close(); await supervisor.close(); return 'idle'; }

    if (step.kind === 'supervisor') {
      // ── the supervisor's turn: the missing seeds and the coder's reply
      // land as user messages; its reply is its own, recorded whole (tool
      // traffic included — the step rule reads terminal turns off it). ────
      await codingAgent.close();
      supervisor.addToolKit(supervisorCardKit(runCard, card.status as LoopColumn));
      return skippedIfLocked(await run(supervisor, step.append.join('\n\n')), 'supervisor');
    }

    // ── deliver / return: one coding turn with the owed text. A returned
    // card's block is resolved and its resolution consumed: clear both
    // AFTER the turn landed, so a crash mid-turn re-delivers instead of
    // losing the human's answer. ──────────────────────────────────────────
    await supervisor.close();
    await this.setPlanMode(codingAgent.session.id, card.status === 'plan');
    const outcome = skippedIfLocked(await run(codingAgent, step.text), 'card');
    if (outcome !== 'turn') return outcome;
    if (step.kind === 'return' && (card.blocked_reason || card.resolution)) {
      await this.patchCard(project, card.number, { blocked_reason: null, resolution: null });
    }
    return 'turn';
  }

  /** Plan mode on the coder's row: a planning turn runs read-only; a build
   *  turn writes. The row is what turn-start answers the agent. */
  private async setPlanMode(sessionId: string, on: boolean): Promise<void> {
    await this.backend.sessions.setPlanMode(sessionId, on);
  }

  /** One session's spend so far, the budget's coin: input + output tokens,
   *  summed off the token log — the same rows GET /sessions/:id/token-usage
   *  serves, read at the object. */
  private async tokensOf(sessionId: string): Promise<number> {
    const t = await this.backend.tokenLog.sessionTotals(sessionId);
    return Number(t.input ?? 0) + Number(t.output ?? 0);
  }

  /** A card write by the loop, at the object — the board bus carries it to
   *  every listener (this engine's own runLoop included, which then reads
   *  the new status and stops). */
  private patchCard(project: ProjectRow, cardNumber: number, fields: CardFields): Promise<unknown> {
    return this.backend.cards.update(project, cardNumber, fields, undefined, CLIENT_ID);
  }

}
