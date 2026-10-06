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
import { Session, type SessionInfo, type TurnStart } from './session.js';
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
  // docs/message-queues.md. A user message starts a turn. Text sent WHILE a
  // turn runs is queued — this queue holds a person's words and nothing
  // else. Queued text RIDES the model's next call while it is mid-run
  // (written then, never handed back), or DRIVES the next run when the
  // model has stopped: the turn goes on with it, same lock. The agent keeps
  // turning while words are queued, so nothing sent is ever left waiting.
  // A driver whose run failed before the model answered it was never
  // written: it comes back on the `returned` event, with the reason.
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
   *  been sent yet come back on `returned`. Then, unless `keepQueue`,
   *  whatever was queued meanwhile goes on with the turn. */
  interrupt(opts: { keepQueue?: boolean } = {}): void {
    if (!this.#abort) return;
    this.#keepQueue = opts.keepQueue === true;
    this.#abort.abort();
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

  /** `texts`: the user's words this turn opens with — its drivers. */
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
        const feed = new TurnFeed(this.backend, this.session.id,
          { agent: this.type, message: opening.join('\n\n'), provider: ready.model.spec.provider, model: ready.model.spec.model },
          { onInterrupt: () => this.interrupt(), onPlanMode: (on) => this.#session.setPlanMode(on),
            onNotice: (text) => this.#handlers.onNotice({ type: 'info', text }) });
        let result: TurnResult;
        try {
          result = await runTurn({
            model: ready.model.model, spec: ready.model.spec, reasoning: ready.model.reasoning,
            system: ready.system, tools: ready.tools, terminal: ready.terminal, history: this.session.messages, maxSteps: ready.model.maxSteps,
            opening,
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
      }, { rebuildSystemPrompt });
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
    }
  }

  /** Words handed back to the app: never written, so nothing is lost. */
  #return(texts: string[], error: PhantomError): void {
    if (texts.length) this.#emit('returned', { texts, error });
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
