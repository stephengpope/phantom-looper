// The looper: the supervisor loop over kanban cards.
//
// There is NO loop object and NO polling. Loop state = card status plus the
// two transcripts; turns are EVENT-driven: a card write runs its loop (the
// kanban routes call `runLoop`), a supervision setting change runs every loop
// in the workspace, boot does ONE recovery pass, a released session lock runs
// that session's card, and a turn that ran chains straight into the next
// turn. The loop is a DIALOGUE: the supervisor and the coding agent talk
// directly — before each turn the step rule (logic.ts) reads both transcripts and
// does the one owed thing: send a kickoff, copy the coder's reply to the
// supervisor and run it, deliver the supervisor's reply to the coder and run
// it, or hand a returned card back to the coder. The run ends when a status
// TOOL fires (the supervisor's `kanban_card_move`, the coder's
// `kanban_card_block` — the card's own PATCH is the event that starts the
// next phase) — the break is `canTurn` no longer matching, never the
// agent's word — or when the token budget runs out, or a turn FAILS (model
// error after retries, anything thrown), which blocks the card with the
// error as blocked_reason. Nothing refires a failed turn. A crash loses
// nothing: the card and its two transcripts are the state, and the boot
// pass picks them up.
//
// The engine is a headless client of this server's own HTTP surface
// (injectFetch): sessions, locks, transcripts, tools, card writes all go
// through the same routes the cli uses. The database is touched directly only
// to DISCOVER (scan cards, find the card's sessions, read the revision
// clock), to STAMP sessions.agent — the loop marks its coder seat at every
// turn START; the transcript save re-derives the column from the writer at
// turn END (sessions.ts agentAfterSave), which is what makes it trustworthy —
// and to CREATE the supervisor's conversation-only session rows (no checkout;
// the loop is their sole creator).
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import type { ModelMessage } from 'ai';
import type { Db } from '../db/client.js';
import { workspaces as workspacesTable, type WorkspaceRow } from '../db/schema.js';
import { currentLoop, loopOf, stampAgent, createSupervisorSession, createLoop, LOOP_CLIENT_ID } from '../sessions.js';
import { resolveMany } from '../settings.js';
import { openSession, SessionLockedError, type OpenedSession } from '../../core/session.js';
import { memoryRecorder, serializeTranscript, type TranscriptHeader } from '../../core/llm/transcript.js';
import { agentModelConfig } from '../../core/llm/agentConfig.js';
import { withCacheBreakpoints } from '../../core/llm/createAgent.js';
import { phantomTools } from '../../core/llm/tools/workspace.js';
import { webTools } from '../../core/llm/tools/web.js';
import {
  kanbanReadTool, loopSupervisorTools, loopBlockTool, type LoopColumn, type LoopCardConfig,
} from '../../core/llm/tools/kanban.js';
import { runCodingTurn, drain, settingsValues, sumTokens } from './turn.js';
import { supervisorAgent, supervisorInstructions } from '../../core/llm/agents/supervisor.js';
import { canTurn, unsentKickoff, nextStep, needsFreshSession, heldBy, LOOP_COLUMNS, type CardRow } from './logic.js';
import { injectFetch } from './injectFetch.js';
import type { BoardEvents } from '../api/boardEvents.js';
import type { SessionEvents } from '../api/sessionEvents.js';
import { logger, errStr } from '../log.js';

const log = logger('looper');
const CLIENT_ID = LOOP_CLIENT_ID;
const BASE = 'http://looper';

export interface LooperDeps {
  db: Db;
  pgPool: pg.Pool;
  app: FastifyInstance;
  apiKey: string;
  /** The board's event bus (api/boardEvents.ts): the engine's card writes go
   *  over HTTP and publish there by themselves; the one thing only the
   *  engine knows is the pairing — a card and its coding session — published
   *  the moment the loop row is written. */
  events?: BoardEvents;
  /** The sessions' live feed (api/sessionEvents.ts), handed straight to every
   *  turn this engine runs: that is how a builder watching a card's session
   *  sees the round happen instead of waiting for the record. */
  sessionEvents?: SessionEvents;
  /** Test seam: the fetch every MODEL call uses (createAgent's own seam).
   *  Production never sets it. */
  modelFetch?: typeof fetch;
}

/** What a turn did — the loop's chaining signal. `turn` means an agent
 *  turn ran and the next step is owed NOW; `moved`/`idle` mean the card was
 *  acted on or nothing was owed; `skipped` means a seat was held elsewhere —
 *  the lock's release re-runs the loop. */
export type TurnOutcome = 'turn' | 'moved' | 'idle' | 'skipped';

/** The chain's token ledger: seeded once from the token API when the loop
 *  picks the card up, each turn's own numbers added as they land. Lives only
 *  for the loop — a restart just seeds again. */
interface Budget { seeded: boolean; spent: number; limit: number | null }

export class LooperEngine {
  private stopped = false;
  private running = new Set<string>();          // workspaceId:seq — one live loop per card
  private pending = new Set<string>();          // called while running — go again after
  private f: typeof fetch;

  constructor(private deps: LooperDeps) {
    this.f = injectFetch(deps.app);
  }

  /** Boot: ONE recovery pass — cards that were mid-loop when the process
   *  died. After this, turns run on events only. */
  start(): void {
    void this.runAllLoops().catch((e) => log.warn({ err: errStr(e) }, 'looper boot pass failed'));
  }
  stop(): void {
    this.stopped = true;
  }
  /** Cards with a round in flight right now — what an api restart would cut
   *  off (and block). GET /health carries it so `phantom-cli update` can warn. */
  runningCount(): number { return this.running.size; }

  /** Run the loop on every card in a loop column, for one workspace (a
   *  supervision setting changed) or all of them (boot). `canTurn` is
   *  re-checked before every turn off fresh rows, so over-calling is harmless. */
  async runAllLoops(workspaceId?: string): Promise<void> {
    const { db, pgPool } = this.deps;
    const rows = workspaceId
      ? await db.select().from(workspacesTable).where(eq(workspacesTable.id, workspaceId))
      : await db.select().from(workspacesTable);
    for (const workspace of rows) {
      let cards: CardRow[];
      try {
        const r = await pgPool.query(
          `select * from "${workspace.schemaName}".cards
           where status = any($1) and not archived`, [[...LOOP_COLUMNS]]);
        cards = r.rows as CardRow[];
      } catch { continue; }
      for (const card of cards) void this.runLoop(workspace.id, card.seq);
    }
  }

  /** A released session lock is the one event a skipped turn waits on: if
   *  the session sits in a loop (either seat), its card's loop runs. The
   *  engine's OWN releases — every turn ends in one — are ignored, or each
   *  turn's cleanup would refire the turn it just finished. */
  async runLoopOfSession(sessionId: string, releasedBy: string): Promise<void> {
    if (releasedBy === CLIENT_ID) return;
    const loop = await loopOf(this.deps.db, sessionId).catch(() => undefined);
    if (loop) void this.runLoop(loop.workspaceId, loop.card);
  }

  /** THE entry: run turns on one card while `canTurn` holds. Re-entrant
   *  calls coalesce (`pending`); the loop never runs twice concurrently on one
   *  card. The card is re-read before every turn, so a status change ends
   *  the loop at the next check — this is also the no-op path for every card
   *  write that changes nothing loop-shaped. A turn that throws blocks the
   *  card with the reason — the failure lands on the board and the loop is
   *  over; nothing retries a failed turn. */
  async runLoop(workspaceId: string, seq: number): Promise<void> {
    const { db, pgPool } = this.deps;
    const claim = `${workspaceId}:${seq}`;
    if (this.running.has(claim)) { this.pending.add(claim); return; }
    this.running.add(claim);
    // One ledger per loop: seeded on the first turn that needs it, carried
    // across the turns, dropped when the loop ends.
    const budget: Budget = { seeded: false, spent: 0, limit: null };
    // Called fire-and-forget from routes: nothing here may reject upward.
    // Every path falls through to the while check, so a call that lands
    // mid-turn (`pending`) is honored — except stop, which ends everything.
    try {
      do {
        this.pending.delete(claim);
        if (this.stopped) return;

        // Fresh rows, then canTurn. Anything else — no card, wrong column,
        // switch off, a failed read — and there is no next turn.
        let workspace: WorkspaceRow | undefined;
        let card: CardRow | undefined;
        try {
          [workspace] = await db.select().from(workspacesTable)
            .where(eq(workspacesTable.id, workspaceId));
          if (!workspace) continue;
          const auto = await resolveMany(db, ['auto_plan', 'auto_build'], { workspace })
            .catch(() => ({ auto_plan: false, auto_build: false }));
          const r = await pgPool.query(
            `select * from "${workspace.schemaName}".cards where seq = $1 and not archived`, [seq]);
          card = r.rows[0] as CardRow | undefined;
          if (!card || !canTurn(card, { plan: Boolean(auto.auto_plan), build: Boolean(auto.auto_build) })) continue;
        } catch (e) {
          log.warn({ card: seq, err: errStr(e) }, 'looper could not read the card');
          continue;
        }

        let outcome: TurnOutcome;
        try {
          outcome = await this.runTurn(workspace, card, budget);
        } catch (e) {
          log.warn({ workspace: workspace.name, card: seq, err: errStr(e) },
            'looper turn failed — blocking the card');
          await this.blockCard(workspace.id, card.id, errStr(e)).catch((be) =>
            log.error({ card: seq, err: errStr(be) }, 'could not block the failed card'));
          continue;
        }
        // A turn just ran — the next step is owed now, not on the next
        // external event. (A status tool's card PATCH re-enters through the
        // route too; `pending` catches that as well.)
        if (outcome === 'turn') this.pending.add(claim);
      } while (this.pending.has(claim));
    } finally {
      this.running.delete(claim);
    }
  }

  /** Fail closed: the turn's error becomes the card's blocked_reason — the
   *  board says WHY, and blocked is not a loop column, so the loop ends. */
  private async blockCard(workspaceId: string, cardId: number, reason: string): Promise<void> {
    await this.patchCard(workspaceId, cardId, {
      status: 'blocked', blocked_reason: `looper turn failed: ${reason}`, resolution: null,
    });
  }

  /** One turn for one card: seat the CODING session, then do the ONE owed
   *  step — a kickoff, a supervisor turn (the coder's reply copied in), a
   *  delivery (the supervisor's reply out), or the return message. Two
   *  sessions, one transcript each: the coder's is the work, the
   *  supervisor's is its side of the dialogue. The supervisor holds no
   *  checkout — its read-only tools point at the coder's session, where the
   *  files are; its board powers are bound to THE card.
   *  Throws on failure — runLoop turns that into a blocked card. */
  async runTurn(workspace: WorkspaceRow, card: CardRow, budget: Budget): Promise<TurnOutcome> {
    const { db, pgPool, apiKey } = this.deps;
    const cfg = await this.settings();

    // The card's current LOOP — the pairing row, written once per run. It
    // names the coder and the supervisor outright; nothing is derived.
    const loop = await currentLoop(db, workspace.id, card.seq);

    // Entering plan is a NEW loop, always — the revision history is the
    // transition clock (logic.ts).
    const lastMove = await pgPool.query(
      `select changed_at from "${workspace.schemaName}".card_revisions
       where seq = $1 and changed ? 'status' order by id desc limit 1`, [card.seq]);
    const fresh = needsFreshSession(card.status, loop?.createdAt ?? null,
      lastMove.rows[0]?.changed_at ?? null);

    let opened: OpenedSession;
    let supervisorSessionId: string;
    try {
      if (loop && !fresh) {
        opened = await openSession({
          baseUrl: BASE, apiKey, clientId: CLIENT_ID, label: heldBy('coding', card.status),
          fetch: this.f, lock: true, sessionId: loop.codingSessionId,
        });
        supervisorSessionId = loop.supervisorSessionId;
      } else {
        // A new run: the coder (with its folder), the supervisor (a
        // conversation on that same folder), and the loop row naming the
        // pair — born together, so no seat can ever be missing or guessed.
        opened = await openSession({
          baseUrl: BASE, apiKey, clientId: CLIENT_ID, label: heldBy('coding', card.status),
          fetch: this.f, lock: true, workspaceId: workspace.id,
        });
        const sup = await createSupervisorSession(db, workspace.id,
          String(opened.session.folderId ?? opened.session.id));
        await createLoop(db, workspace.id, card.seq, opened.session.id, sup.id);
        this.deps.events?.publish(workspace.id, { event: 'session', card: card.seq, id: opened.session.id, name: null });
        supervisorSessionId = sup.id;
      }
    } catch (e) {
      if (e instanceof SessionLockedError) {
        log.info({ card: card.seq }, 'card session held elsewhere — skipping this turn');
        return 'skipped';
      }
      throw e;
    }
    let supOpened: OpenedSession | undefined;
    try {
      // The loop drives this seat now: say so on the row BEFORE the turn
      // runs, so a window watching it reads `coding agent ⠹ building` and
      // /resume reads `coder` while it lasts — not only once the save lands.
      // A person who typed into it since (agent null) handed it back by
      // moving the card.
      await stampAgent(db, opened.session.id, 'coding');
      // ── the token budget — seeded once per loop, checked before every
      // turn, each turn's own numbers added as they land. Breach is a card
      // state a human can see, like every other loop exit. ─────────────────
      if (!budget.seeded) {
        const b = await resolveMany(db, ['loop_budget_tokens'], { workspace })
          .catch(() => ({ loop_budget_tokens: null }));
        budget.limit = b.loop_budget_tokens == null ? null : Number(b.loop_budget_tokens);
        if (budget.limit != null) {
          budget.spent = await this.tokensOf(opened.session.id)
            + await this.tokensOf(supervisorSessionId);
        }
        budget.seeded = true;
      }
      if (budget.limit != null && budget.spent >= budget.limit) {
        await this.patchCard(workspace.id, card.id, {
          status: 'blocked',
          blocked_reason: `token budget exhausted: ${budget.spent} of ${budget.limit} tokens used`,
          resolution: null,
        });
        log.info({ card: card.seq, spent: budget.spent, limit: budget.limit }, 'looper budget exhausted');
        return 'moved';
      }

      // The loop's card-bound tools: the coder's block, the supervisor's
      // move + items. Bound at build time — no card input, so neither agent
      // can ever act on a card other than the one it is running.
      const cardCfg: LoopCardConfig = { baseUrl: BASE, apiKey, workspaceId: workspace.id,
        cardId: card.id, seq: card.seq, fetch: this.f };
      const coderDeps = { ...this.turnDeps(card.seq), extraTools: loopBlockTool(cardCfg) };

      const opener = unsentKickoff(card, opened.messages);
      if (opener) {
        const t = await runCodingTurn(coderDeps, opened, workspace.id, opener.text, opener.planMode, cfg);
        budget.spent += t.tokens;
        return 'turn';
      }

      try {
        supOpened = await openSession({
          baseUrl: BASE, apiKey, clientId: CLIENT_ID, label: heldBy('supervisor', card.status),
          fetch: this.f, lock: true, sessionId: supervisorSessionId,
        });
      } catch (e) {
        if (e instanceof SessionLockedError) {
          log.info({ card: card.seq }, 'supervisor session held elsewhere — skipping this turn');
          return 'skipped';
        }
        throw e;
      }

      const step = nextStep(card, opened.messages, supOpened.messages);
      if (!step) return 'idle';

      if (step.kind === 'supervisor') {
        // ── the supervisor's turn: the missing seeds and the coder's reply
        // land as user messages; its reply is its own, recorded whole (tool
        // traffic included — the step rule reads terminal turns off it). ────
        const model = agentModelConfig(cfg, 'supervisor');
        model.fetch = this.deps.modelFetch;
        model.onRetry = (t) => log.warn({ card: card.seq, agent: 'supervisor' }, t);
        const tools = {
          ...await phantomTools({ baseUrl: BASE, apiKey, sessionId: opened.session.id,
            pick: 'readonly', fetch: this.f }),
          ...kanbanReadTool({ baseUrl: BASE, apiKey, workspaceId: workspace.id, fetch: this.f }),
          // Web search + fetch are capabilities, not mutations: fetched pages
          // land outside repo/, and a judge may need the docs the card cites.
          ...webTools({ baseUrl: BASE, apiKey, sessionId: opened.session.id, fetch: this.f }),
          ...loopSupervisorTools(cardCfg, card.status as LoopColumn),
        };
        const incoming: ModelMessage[] = step.append.map((t) => ({ role: 'user', content: t }));
        const messages = [...supOpened.messages, ...incoming];
        const agent = supervisorAgent(model, tools);
        // Cache marks on a copy — the supervisor's growing conversation reads
        // its own prefix back each turn; the transcript stays clean. The
        // step seam collects the WHOLE turn (tool calls included — the step
        // rule reads terminal turns off this record).
        const { record, events, messages: turnMessages } = memoryRecorder(messages.length);
        // Streamed, not generated, for one reason: a supervisor session is
        // openable read-only from /resume, and the review half of a run
        // should be watchable as it happens like the coding half. The record
        // is identical either way — createAgent's `record` seam collects the
        // same steps — and the reply text is never read here (the step rule
        // reads the saved transcript).
        const feed = this.deps.sessionEvents;
        const supId = supOpened.session.id;
        feed?.publish(supId, CLIENT_ID, { event: 'turn-start', agent: 'supervisor', message: step.append.join('\n\n') });
        try {
          const r = await agent.stream({ messages: withCacheBreakpoints(messages), record });
          await drain(r, (part) => feed?.publishPart(supId, CLIENT_ID, part));
        } catch (e) {
          feed?.publish(supId, CLIENT_ID, { event: 'error', message: (e as Error).message });
          throw e;
        } finally {
          feed?.publish(supId, CLIENT_ID, { event: 'turn-end' });
        }
        const supHeader: TranscriptHeader = supOpened.header ?? {
          type: 'session', agent: CLIENT_ID, provider: model.provider, model: model.model,
          created_at: new Date().toISOString(), system_prompt: supervisorInstructions(),
          session_id: supOpened.session.id, card: card.seq,
        };
        await supOpened.saveTranscript(serializeTranscript(supHeader,
          [...messages, ...turnMessages],
          [...supOpened.events, ...events]));
        budget.spent += sumTokens(events);
        return 'turn';
      }

      // ── deliver / return: one coding turn with the owed text. A returned
      // card's block is resolved and its resolution consumed: clear both
      // AFTER the turn landed, so a crash mid-turn re-delivers instead of
      // losing the human's answer. ──────────────────────────────────────────
      const t = await runCodingTurn(coderDeps, opened, workspace.id,
        step.text, card.status === 'plan', cfg);
      budget.spent += t.tokens;
      if (step.kind === 'return' && (card.blocked_reason || card.resolution)) {
        await this.patchCard(workspace.id, card.id, { blocked_reason: null, resolution: null });
      }
      return 'turn';
    } finally {
      // close() surfaces a failed background save (the record did not land)
      // — a throw here is a turn failure like any other. The nested finally
      // keeps one throwing close from leaking the other seat's lock.
      try { await supOpened?.close(); }
      finally { await opened.close(); }
    }
  }

  /** One session's spend so far, the budget's coin: input + output tokens
   *  from the token API (summed from the transcript's usage lines, cached by
   *  stamp server-side). */
  private async tokensOf(sessionId: string): Promise<number> {
    const r = await this.f(`${BASE}/sessions/${sessionId}/token-usage`, {
      headers: { authorization: `Bearer ${this.deps.apiKey}` } });
    const j = await r.json() as { ok: boolean; data?: { input: number; output: number } };
    if (!j.ok || !j.data) return 0;
    return (j.data.input ?? 0) + (j.data.output ?? 0);
  }

  private async patchCard(workspaceId: string, cardId: number, body: unknown): Promise<void> {
    const r = await this.f(`${BASE}/workspaces/${workspaceId}/cards/${cardId}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${this.deps.apiKey}`, 'content-type': 'application/json',
        'x-phantom-looper-client': CLIENT_ID },
      body: JSON.stringify(body),
    });
    const j = await r.json() as { ok: boolean; error?: { message: string } };
    if (!j.ok) throw new Error(`card patch failed: ${j.error?.message}`);
  }

  private turnDeps(card?: number) {
    return { f: this.f, apiKey: this.deps.apiKey, base: BASE,
      modelFetch: this.deps.modelFetch, sessionEvents: this.deps.sessionEvents, client: CLIENT_ID,
      onRetry: (t: string) => log.warn({ card, agent: 'coding' }, t) };
  }

  private settings(): Promise<Record<string, unknown>> {
    return settingsValues(this.turnDeps());
  }
}
