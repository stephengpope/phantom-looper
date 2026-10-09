// The base of every agent. A subclass says its type and its system prompt
// LAYOUT (systemPrompt.ts) — nothing else. The layout goes with the create
// request; the server assembles the prompt and writes it with the row;
// every turn sends it as stored. The volatile section (the date, the skills,
// the secrets) is reassembled on the first turn after a resume, and when a
// turn asks (sendMessage's rebuildSystemPrompt): the layout rides the
// turn-start, the server rebuilds that section under the hold and marks the
// record. The base wires the session (session.ts),
// the model (model/modelResolver.ts), the tools (toolkit.ts) and the turn
// (turn.ts), and owns the user's queue, interrupts and events.
//
//   class CodingAgent extends Agent {
//     readonly type = 'coding';
//     static readonly systemPromptLayout: SystemPromptLayout = { stable: [...], context: [...], volatile: [...] };
//   }
//   const agent = await CodingAgent.resumeSession(backend, handlers, sessionId);
//
// Resuming only reads: nothing is locked or written until a turn starts.
import type { BackendClient } from './backend.js';
import { PhantomError, asPhantomError } from './errors.js';
import { Emitter, type AgentEvents } from './events.js';
import { TurnFeed } from './feed.js';
import { systemMessages, CACHED_BLOCKS } from './model/cache.js';
import { ModelResolver, type ResolvedModel } from './model/modelResolver.js';
import type { SystemModelMessage, Tool } from 'ai';
import { BACKEND_RETRY, MODEL_RETRY, type RetryPolicy } from './model/retry.js';
import { Session, type SessionInfo, type TurnStart, type HandoffTarget } from './session.js';
import { ToolKitSet, serverToolKit, type ToolKit } from './toolkit.js';
import { runTurn, type TurnResult } from './turn.js';
import { UserMessageQueue, type UserMessages } from './userMessages.js';
import { systemPromptBlocks, type SystemPromptLayout } from './systemPrompt.js';
import { partialMessageLine } from './transcript.js';

export interface Notice {
  type: 'retry' | 'cache' | 'info';
  text: string;
}

export interface AgentHandlers {
  /** Every error the runtime produces, once, with code and stack. Required. */
  onError(error: PhantomError): void;
  /** Non-error information: retries, cache limits, a feed that dropped. Required. */
  onNotice(notice: Notice): void;
  /** How hard to retry. Defaults: BACKEND_RETRY (~15s) for the backend,
   *  MODEL_RETRY (3 min) for providers. */
  retry?: { backend?: Partial<RetryPolicy>; model?: Partial<RetryPolicy> };
}

/** What the base builds a subclass from — `resumeSession` / `create` are
 *  the only callers. Subclasses declare no constructor. */
interface AgentDeps { backend: BackendClient; handlers: AgentHandlers; session: Session }
type AgentClass<T extends Agent> = (new (deps: AgentDeps) => T) & { systemPromptLayout?: SystemPromptLayout };

/** What `disconnect()` answers: the turn went to a session runner, or it
 *  stayed here and why (no runner took it, or the turn ended first). */
export type Disconnected = { handedOff: true; runner: HandoffTarget } | { handedOff: false; reason: string };

/** What a user message may ask of the turn it opens. */
export interface SendOptions {
  /** Reassemble the prompt's volatile section — the date, the skills, the
   *  secrets — before the first model call. Done on its own on the first
   *  turn after a resume. */
  rebuildSystemPrompt?: boolean;
}

export abstract class Agent {
  /** Which agent this is — the server answers its model and tools by type. */
  abstract readonly type: string;

  /** The connection, retrying: a network failure or a 5xx is retried per
   *  the handlers' policy, each attempt a notice; 409s (locked, conflict)
   *  are facts and never retried. For a subclass's own calls too. */
  readonly backend: BackendClient;
  readonly session: SessionInfo;

  readonly #session: Session;
  readonly #handlers: AgentHandlers;
  readonly #kits = new ToolKitSet();
  readonly #queue = new UserMessageQueue();
  readonly #events = new Emitter();
  #modelResolver!: ModelResolver;
  #turn: Promise<TurnResult> | null = null;
  #abort: AbortController | null = null;
  #keepQueue = false;
  #closed = false;
  /** The model was asked: from here, a run's own words are the loop's to
   *  hand back (`unsent`), not the turn's. */
  #started = false;
  /** A failed run's drivers, waiting for the turn to report them. */
  #unsent: string[] = [];
  /** The next turn reassembles the volatile section: set by a resume and by
   *  sendMessage's option; taken by the turn that starts. */
  #rebuildSystemPrompt = false;
  /** What the person received of the last reply, not yet in the record:
   *  written under the session's hold at the next chance (partialMessage). */
  #partials: string[] = [];
  /** `disconnect()` was called: the running turn hands off at its next step
   *  boundary (turn.ts's stop condition). Cleared when the hand-off landed
   *  or was refused. */
  #handoff = false;
  /** The disconnect waiting to be answered, if one is. */
  #disconnecting: { resolve(answer: Disconnected): void } | null = null;

  /** @internal — through `resumeSession` / `create` only. */
  constructor({ backend, handlers, session }: AgentDeps) {
    this.backend = backend;
    this.#handlers = handlers;
    this.#session = session;
    this.session = session;
  }

  // ── resuming / creating ────────────────────────────────────────────────

  /** An existing session: the row as it stands, then the record. Its first
   *  turn reassembles the prompt's volatile section — the facts most likely
   *  to have moved since the row was born. */
  static async resumeSession<T extends Agent>(this: AgentClass<T>, backend: BackendClient, handlers: AgentHandlers, sessionId: string): Promise<T> {
    const agent = await Agent.#build(this, backend, handlers, () => Promise.resolve(sessionId), `resuming session ${sessionId}`);
    agent.#rebuildSystemPrompt = true;
    return agent;
  }

  /** A new session: the app makes the row its own way (the route is the
   *  app's) and answers its id; then as `resumeSession`. */
  static async create<T extends Agent>(this: AgentClass<T>, backend: BackendClient, handlers: AgentHandlers,
    createRow: (backend: BackendClient) => Promise<{ id: string }>): Promise<T> {
    return Agent.#build(this, backend, handlers, async (connection) => (await createRow(connection)).id, 'creating the session');
  }

  // ── the app's side ─────────────────────────────────────────────────────

  get busy(): boolean { return this.#turn !== null; }
  /** What the user has sent that no model call has taken yet. */
  get userMessages(): UserMessages { return this.#queue; }

  on<E extends keyof AgentEvents>(event: E, listener: (payload: AgentEvents[E]) => void): () => void {
    return this.#events.on(event, listener);
  }

  /** Tools only this app can serve, alongside the server's. */
  addToolKit(kit: ToolKit): this { this.#kits.add(kit); return this; }

  // ── the user's words ───────────────────────────────────────────────────
  // A user message starts a turn. Text sent WHILE a
  // turn runs is queued — this queue holds a person's words and nothing
  // else. Queued text RIDES the model's next call while it is mid-run
  // (written then, never handed back), or DRIVES the next run when the
  // model has stopped: the turn goes on with it, same lock. The agent keeps
  // turning while words are queued, so nothing sent is ever left waiting.
  // A driver whose run failed before the model answered it was never
  // written: it goes back to the front of the queue and waits — the next
  // message takes it along; nothing retries on its own. The `returned`
  // event says which words and why.
  // A stop cuts the model loop; what is queued goes on with the turn unless
  // the stop says `keepQueue` — then it stays queued, for the app to show.

  /** The user's message. No turn running → a turn starts with it and this
   *  resolves with the result (the last run's, when queued words kept it
   *  going). A turn running → queued; resolves null (an option asked of it
   *  holds for the next turn that starts). */
  sendMessage(text: string, opts: SendOptions = {}): Promise<TurnResult | null> {
    if (opts.rebuildSystemPrompt) this.#rebuildSystemPrompt = true;
    if (this.busy) { this.#queue.add(text); return Promise.resolve(null); }
    if (this.#closed) return Promise.reject(new PhantomError('busy', 'the agent is closed'));
    const turn = this.#guard(() => this.#turns([...this.#queue.drain(), text]));
    this.#turn = turn;
    return turn.finally(() => { if (this.#turn === turn) this.#turn = null; });
  }

  /** Turns, for as long as the user has words queued: words that arrived
   *  after the model's last look (while the turn was closing) drive one more
   *  turn instead of waiting for the next message. A stop or a failure ends
   *  it — what is still queued stays queued. */
  async #turns(texts: string[]): Promise<TurnResult> {
    let result = await this.#turnBody(texts);
    while (result.outcome === 'done' && !this.#closed && this.#queue.length) result = await this.#turnBody(this.#sent());
    return result;
  }

  /** Stop the running model loop — the standard abort, as a fetch is
   *  stopped. Finished tool calls keep their results. Words that had not
   *  been sent yet go back to the queue (`returned`). Then, unless `keepQueue`,
   *  whatever was queued meanwhile goes on with the turn. */
  interrupt(opts: { keepQueue?: boolean } = {}): void {
    if (!this.#abort) return;
    this.#keepQueue = opts.keepQueue === true;
    this.#abort.abort();
  }

  /** Let a session runner finish the running turn. Nothing is cut: the step
   *  in flight completes — the model's answer and every tool result in the
   *  record — and at that boundary the server moves the hold to a runner,
   *  which calls the model next, opening with whatever was queued here.
   *  Resolves once that landed, or once it did not: no runner took it (this
   *  agent goes on itself, nothing lost), or the turn ended on its own
   *  first. After a hand-off this agent is free; the turn is on the
   *  session feed like anyone else's. */
  disconnect(): Promise<Disconnected> {
    if (!this.#turn) return Promise.resolve({ handedOff: false, reason: 'no turn is running' });
    return new Promise<Disconnected>((resolve) => {
      if (this.#disconnecting) { const previous = this.#disconnecting; this.#disconnecting = { resolve: (answer) => { previous.resolve(answer); resolve(answer); } }; return; }
      this.#disconnecting = { resolve };
      this.#handoff = true;
    });
  }

  #settleDisconnect(answer: Disconnected): void {
    this.#handoff = false;
    const waiting = this.#disconnecting;
    this.#disconnecting = null;
    waiting?.resolve(answer);
  }

  /** Go on with a turn another driver handed off: the record is whole up to
   *  a step boundary, `opening` is what that driver had queued (often
   *  nothing), and the hold is already this client's. One turn from here to
   *  the end, as `sendMessage` runs one — without the prompt rebuild a
   *  resume asks for: the turn is mid-flight, not new. */
  continueTurn(opening: string[]): Promise<TurnResult> {
    if (this.busy) return Promise.reject(new PhantomError('busy', 'a turn is already running on this agent'));
    if (this.#closed) return Promise.reject(new PhantomError('busy', 'the agent is closed'));
    this.#rebuildSystemPrompt = false;
    const turn = this.#guard(() => this.#turns([...this.#queue.drain(), ...opening]));
    this.#turn = turn;
    return turn.finally(() => { if (this.#turn === turn) this.#turn = null; });
  }

  /** The person received the last reply only up to `text` — a reply cut off
   *  while it was being spoken, after the model had already written it (the
   *  host's speaker knows the cut; the stream does not). The conversation
   *  is cut at once; the record gets a partial_message line under the
   *  session's hold at the next chance: before anything else this turn
   *  writes, or at the next turn's start. A text host never needs this —
   *  a stream cut by `interrupt` is recorded at the cut already. */
  partialMessage(text: string): void {
    this.#session.cutLastReply(text);
    this.#partials.push(text);
  }

  /** Write what partialMessage holds, in order, before anything else lands.
   *  Queued on the record at once (the record keeps the order); the promise
   *  is for the caller that must know it landed. */
  #flushPartials(): Promise<unknown> {
    if (!this.#partials.length) return Promise.resolve();
    const lines = this.#partials.splice(0).map(partialMessageLine);
    return this.#session.append(lines);
  }

  /** Stop, and wait until the last turn's end reached the server — its
   *  hold let go — so nothing of this agent is still in flight. */
  async close(): Promise<void> {
    this.#closed = true;
    this.interrupt({ keepQueue: true });
    if (this.#turn) await this.#turn.then(() => undefined, () => undefined);
    await this.#session.ended();
  }

  // ── the turn ───────────────────────────────────────────────────────────
  // One turn = one lock = one result.

  /** `texts`: the user's words this turn opens with — its drivers. Empty
   *  for a turn continued from a hand-off: the record ends at a step
   *  boundary and the model is simply called again. */
  async #turnBody(texts: string[]): Promise<TurnResult> {
    this.#keepQueue = false;
    const signal = this.#nextSignal();
    const nothing: TurnResult = { text: '', messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outcome: 'interrupted' };
    const rebuildSystemPrompt = this.#rebuildSystemPrompt ? this.#layout() : undefined;
    try {
      return await this.#session.turn(this.type, signal, async (start) => {
        this.#rebuildSystemPrompt = false;
        const ready = await this.#prepare(start, signal);
        // Stopped before the model was asked: nothing was sent.
        if (!ready || signal.aborted) { this.#return(texts, this.#stopped()); return nothing; }
        const opening = texts;
        this.#started = true;
        this.#emit('turn-start', { texts: opening,
          model: { provider: ready.model.spec.provider, model: ready.model.spec.model, reasoning: ready.model.spec.reasoning } });
        // The turn's feed: reopened after a refused hand-off (its stream was
        // closed for the hand-off), so `feed` is the current one.
        const openFeed = (words: string[]) => new TurnFeed(this.backend, this.session.id,
          { agent: this.type, message: words.join('\n\n'), provider: ready.model.spec.provider, model: ready.model.spec.model },
          { onInterrupt: () => this.interrupt(), onHandoff: () => { void this.disconnect(); }, onPlanMode: (on) => this.#session.setPlanMode(on),
            onNotice: (text) => this.#handlers.onNotice({ type: 'info', text }) });
        let feed = openFeed(opening);
        // One model loop from `words`, over the conversation as it stands
        // now — run once, and again from the boundary when a hand-off is
        // refused.
        const run = (words: string[]) => runTurn({
            model: ready.model.model, spec: ready.model.spec, reasoning: ready.model.reasoning,
            system: ready.system, tools: ready.tools, terminal: ready.terminal, history: this.session.messages, maxSteps: ready.model.maxSteps,
            opening: words,
            handoff: () => this.#handoff,
            loopSignal: () => this.#nextSignal(),
            pending: () => this.#sent(),
            afterStop: () => (this.#keepQueue || this.#closed ? [] : this.#sent()),
            // Both appends are queued before the first await: the record
            // keeps the order the turn made them in.
            record: async (lines) => {
              const partials = this.#flushPartials();
              const added = await this.#session.append(lines);
              await partials;
              if (added.length) this.#emit('step', { messages: added, usage: this.session.usage });
            },
            onPart: (part) => { feed.part(part); this.#emit('part', part); },
            onToolError: (name, error) => this.#emit('tool-error', { name, error }),
            unsent: (unsent) => { this.#unsent = unsent; },
          });
        let result: TurnResult;
        try {
          result = await run(opening);
          // At a step boundary with a hand-off asked: the words no model call
          // took are the next driver's opening. Taken: the server moves the
          // hold and the runner goes on; this turn is over here, its hold
          // not ours to release. Refused: nothing changed, the record is
          // whole, so this driver goes on from the same boundary with those
          // words — the hand-off cost nothing but the asking.
          while (result.outcome === 'handed_off') {
            const queue = this.#queue.drain();
            // Everything this driver still owes the record and the feed goes
            // out NOW, under its own hold — after the hand-off the hold is
            // the runner's and a late write would be refused.
            await Promise.all([feed.end(), this.#flushPartials()]);
            const runner = await this.#tryHandoff(queue);
            if (runner) {
              start.handedOff();
              this.#emit('handed-off', { runner });
              return result;
            }
            // Refused: the turn goes on here, so watchers see a turn again.
            feed = openFeed(queue);
            if (queue.length) this.#emit('user-message', { texts: queue });
            const more = await run(queue);
            result = { text: more.text, messages: [...result.messages, ...more.messages], outcome: more.outcome,
              usage: { input: result.usage.input + more.usage.input, output: result.usage.output + more.usage.output,
                cacheRead: result.usage.cacheRead + more.usage.cacheRead, cacheWrite: result.usage.cacheWrite + more.usage.cacheWrite } };
          }
        } catch (error) {
          feed.error((error as Error).message);
          start.endAfter(feed.end());
          const unsent = this.#unsent.splice(0);
          if (unsent.length) this.#return(unsent, asPhantomError(error, 'internal', 'the turn'));
          throw error;
        }
        // The model has stopped and the record holds the turn: the result is
        // the caller's now. The feed closes and the hold is let go in the
        // background (Session.turn) — the next turn waits for both.
        start.endAfter(Promise.all([feed.end(), this.#flushPartials()]));
        this.#emit('turn-end', result);
        return result;
      }, { rebuildSystemPrompt, message: texts.join('\n\n') || undefined });
    } catch (error) {
      // Before the model was asked (the hold refused, the server unreachable,
      // a stop while the turn was starting): nothing was written, so the
      // words come back with the reason.
      if (!this.#started) this.#return(texts, signal.aborted ? this.#stopped() : asPhantomError(error, 'internal', 'starting the turn'));
      if (signal.aborted) return nothing;
      throw error;
    } finally {
      this.#abort = null;
      this.#started = false;
      // A disconnect the turn outran (it ended, failed or was stopped before
      // a boundary came): answered here, so nobody waits on it.
      if (this.#disconnecting) this.#settleDisconnect({ handedOff: false, reason: 'the turn ended before it could be handed off' });
      this.#handoff = false;
    }
  }

  /** The hand-off itself, at the boundary: who took it, or null when nobody
   *  did (refused, unreachable) — said once as a notice, and the disconnect
   *  answered either way. */
  async #tryHandoff(opening: string[]): Promise<HandoffTarget | null> {
    try {
      const runner = await this.#session.handoff(opening);
      this.#settleDisconnect({ handedOff: true, runner });
      return runner;
    } catch (error) {
      const reason = asPhantomError(error, 'internal', 'handing the turn off');
      this.#handlers.onNotice({ type: 'info', text: `not handed off — ${reason.message}; going on here` });
      this.#settleDisconnect({ handedOff: false, reason: reason.message });
      return null;
    }
  }

  /** Words the model never answered: back to the front of the queue, and
   *  the app is told. Never written, so nothing is lost or doubled. */
  #return(texts: string[], error: PhantomError): void {
    if (!texts.length) return;
    this.#queue.unsent(texts);
    this.#emit('returned', { texts, error });
  }

  #stopped(): PhantomError { return new PhantomError('interrupted', 'stopped before the model was asked', { retryable: false }); }

  /** The subclass's layout — what a rebuild sends. A subclass without one
   *  cannot rebuild: config_invalid, the same word a session with no prompt gets. */
  #layout(): SystemPromptLayout {
    const layout = (this.constructor as AgentClass<this>).systemPromptLayout;
    if (!layout) throw new PhantomError('config_invalid', `${this.constructor.name} declares no systemPromptLayout — nothing to rebuild the prompt from`);
    return layout;
  }

  /** A fresh abort signal: the one `interrupt` fires next. */
  #nextSignal(): AbortSignal {
    this.#abort = new AbortController();
    return this.#abort.signal;
  }

  /** What the user sent while the turn ran, taken. */
  #sent(): string[] {
    const sent = this.#queue.drain();
    if (sent.length) this.#emit('user-message', { texts: sent });
    return sent;
  }

  /** Everything a turn needs before it sends anything, from what turn-start
   *  answered: the record made current (the server's queued messages are in
   *  it now), plan mode, the model, the prompt as stored, the tools. Null when a stop
   *  landed meanwhile — nothing was sent, nothing recorded, the queue
   *  untouched. */
  async #prepare(start: TurnStart & { recordMoved: boolean }, signal: AbortSignal): Promise<{ model: ResolvedModel; system: SystemModelMessage[]; tools: Record<string, Tool>; terminal: string[] } | null> {
    try {
      const gained = await this.#session.makeCurrent(start.recordMoved, signal);
      if (gained) this.#emit('reloaded', { messages: this.session.messages, from: gained.from, added: gained.added, now: this.session.transcriptUpdatedAt });
      await this.#flushPartials();
      this.#session.setPlanMode(start.planMode);
      const model = this.#modelResolver.resolve(start.config);
      const stored = this.session.row.system_prompt;
      if (!stored) throw new PhantomError('config_invalid', `session ${this.session.id} has no system prompt`);
      const { messages: system, uncached } = systemMessages(systemPromptBlocks(stored), model.spec.provider);
      if (uncached) this.#handlers.onNotice({ type: 'cache', text: `${uncached} system prompt block(s) beyond the first ${CACHED_BLOCKS} are not cached on ${model.spec.provider}` });
      this.#kits.add(serverToolKit(start.tools));
      const { tools, terminal } = await this.#kits.resolve({ backend: this.backend, sessionId: this.session.id, projectId: this.session.projectId,
        workspaceId: this.session.workspaceId, readonly: () => this.session.planMode });
      return { model, system, tools, terminal };
    } catch (error) {
      if (signal.aborted) return null;
      throw error;
    }
  }

  // ── wiring ─────────────────────────────────────────────────────────────

  /** After construction, once `type` exists (a subclass field lands after
   *  the base constructor ran). */
  #wire(): this {
    this.#modelResolver = new ModelResolver(this.backend, this.type, this.session.id, {
      retry: { ...MODEL_RETRY, ...this.#handlers.retry?.model },
      notice: (text) => this.#handlers.onNotice({ type: 'retry', text }),
      onBillingError: (error) => this.#handlers.onError(error),
    });
    return this;
  }

  /** Every awaited public call: the error reaches onError first, then the caller. */
  async #guard<T>(body: () => Promise<T>): Promise<T> {
    try { return await body(); }
    catch (error) {
      const phantomError = asPhantomError(error, 'internal', 'agent');
      this.#handlers.onError(phantomError);
      throw phantomError;
    }
  }

  #emit<E extends keyof AgentEvents>(event: E, payload: AgentEvents[E]): void {
    this.#events.emit(event, payload, (error) => this.#handlers.onError(asPhantomError(error, 'listener_threw', `a listener for "${event}" threw`)));
  }

  /** The one way an agent comes to be: the session id (made or given), the
   *  session read, the agent built and wired. Every failure reaches onError
   *  first, then the caller. */
  static async #build<T extends Agent>(ctor: AgentClass<T>, backend: BackendClient, handlers: AgentHandlers,
    sessionId: (connection: BackendClient) => Promise<string>, what: string): Promise<T> {
    try {
      const connection = backend.withRetry({ ...BACKEND_RETRY, ...handlers.retry?.backend }, (text) => handlers.onNotice({ type: 'retry', text }));
      return new ctor({ backend: connection, handlers, session: await Session.load(connection, handlers, await sessionId(connection)) }).#wire();
    } catch (error) {
      const phantomError = asPhantomError(error, 'internal', what);
      handlers.onError(phantomError);
      throw phantomError;
    }
  }
}
