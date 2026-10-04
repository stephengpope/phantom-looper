// The base of every agent. A subclass says its type and its system prompt
// LAYOUT (systemPrompt.ts) — nothing else. The layout goes with the create
// request; the server assembles the prompt once and writes it with the row;
// every turn sends it as stored. The base wires the session (session.ts),
// the model (model/modelHandle.ts), the tools (toolkit.ts) and the turn
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
import { ModelHandle, type ResolvedModel } from './model/modelHandle.js';
import type { SystemModelMessage, Tool } from 'ai';
import { BACKEND_RETRY, MODEL_RETRY, type RetryPolicy } from './model/retry.js';
import { Session, type SessionInfo, type TurnStart } from './session.js';
import { ToolKitSet, serverToolKit, type ToolKit } from './toolkit.js';
import { runTurn, type TurnResult } from './turn.js';
import { UserMessageQueue, type UserMessages } from './userMessages.js';
import { systemPromptBlocks } from './systemPrompt.js';
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
type AgentClass<T extends Agent> = new (deps: AgentDeps) => T;

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
  #model!: ModelHandle;
  #turn: Promise<TurnResult> | null = null;
  #abort: AbortController | null = null;
  #keepQueue = false;
  #closed = false;
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

  /** An existing session: the row as it stands, then the record. */
  static async resumeSession<T extends Agent>(this: AgentClass<T>, backend: BackendClient, handlers: AgentHandlers, sessionId: string): Promise<T> {
    return Agent.#build(this, backend, handlers, () => Promise.resolve(sessionId), `resuming session ${sessionId}`);
  }

  /** A new session: the app makes the row its own way (the route is the
   *  app's) and answers its id; then as `resumeSession`. */
  static async create<T extends Agent>(this: AgentClass<T>, backend: BackendClient, handlers: AgentHandlers,
    createRow: (backend: BackendClient) => Promise<{ id: string }>): Promise<T> {
    return Agent.#build(this, backend, handlers, async (b) => (await createRow(b)).id, 'creating the session');
  }

  // ── the app's side ─────────────────────────────────────────────────────

  get busy(): boolean { return this.#turn !== null; }
  /** What the user has sent that no model call has taken yet. */
  get userMessages(): UserMessages { return this.#queue; }

  on<E extends keyof AgentEvents>(event: E, fn: (payload: AgentEvents[E]) => void): () => void {
    return this.#events.on(event, fn);
  }

  /** Tools only this app can serve, alongside the server's. */
  addToolKit(kit: ToolKit): this { this.#kits.add(kit); return this; }

  // ── the user's words ───────────────────────────────────────────────────
  // A user message starts a turn. Text sent WHILE a turn runs is queued: it
  // rides the turn's next model call, or continues the turn when the model
  // has stopped. A stop cuts the model loop; what is queued then goes on
  // with the SAME turn — same lock, same feed — unless the stop says
  // `keepQueue`: then the turn ends, and the queue goes ahead of the next
  // message the user sends. The queue never takes the session on its own.

  /** The user's message. No turn running → a turn starts with it and this
   *  resolves with the result. A turn running → queued; resolves null. */
  sendMessage(text: string): Promise<TurnResult | null> {
    if (this.busy) { this.#queue.add(text); return Promise.resolve(null); }
    if (this.#closed) return Promise.reject(new PhantomError('busy', 'the agent is closed'));
    const p = this.#guard(() => this.#turnBody([...this.#queue.drain(), text]));
    this.#turn = p;
    return p.finally(() => { if (this.#turn === p) this.#turn = null; });
  }

  /** Stop the running model loop. Finished tool calls keep their results;
   *  a turn that had not sent anything yet ends with nothing recorded and
   *  its message dropped — the user said stop. Then, unless `keepQueue`,
   *  whatever was sent meanwhile goes on with the turn. */
  interrupt(opts: { keepQueue?: boolean } = {}): void {
    if (!this.#abort) return;
    this.#keepQueue = opts.keepQueue === true;
    this.#abort.abort(new Error('interrupted'));
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

  /** Write what partialMessage holds, in order, before anything else lands. */
  async #flushPartials(): Promise<void> {
    if (!this.#partials.length) return;
    const lines = this.#partials.splice(0).map(partialMessageLine);
    await this.#session.append(lines);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.interrupt({ keepQueue: true });
    if (this.#turn) await this.#turn.then(() => undefined, () => undefined);
  }

  // ── the turn ───────────────────────────────────────────────────────────
  // One turn = one lock = one result.

  /** `texts`: the user's words this turn opens with. */
  async #turnBody(texts: string[]): Promise<TurnResult> {
    this.#keepQueue = false;
    const signal = this.#nextSignal();
    const nothing: TurnResult = { text: '', messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outcome: 'interrupted' };
    try {
      return await this.#session.turn(this.type, signal, async (start) => {
        const ready = await this.#prepare(start, signal);
        if (!ready) return nothing;
        const opening = texts;
        this.#emit('turn-start', { texts: opening,
          model: { provider: ready.model.spec.provider, model: ready.model.spec.model, reasoning: ready.model.spec.reasoning } });
        const feed = new TurnFeed(this.backend, this.session.id,
          { agent: this.type, message: opening.join('\n\n'), provider: ready.model.spec.provider, model: ready.model.spec.model },
          { onInterrupt: () => this.interrupt(), onPlanMode: (on) => this.#session.setPlanMode(on),
            onNotice: (text) => this.#handlers.onNotice({ type: 'info', text }) });
        let r: TurnResult;
        try {
          r = await runTurn({
            model: ready.model.model, spec: ready.model.spec, reasoning: ready.model.reasoning,
            system: ready.system, tools: ready.tools, terminal: ready.terminal, history: this.session.messages, maxSteps: ready.model.maxSteps,
            opening,
            loopSignal: () => this.#nextSignal(),
            pending: () => this.#sent(),
            afterStop: () => (this.#keepQueue || this.#closed ? [] : this.#sent()),
            record: async (lines) => {
              await this.#flushPartials();
              const added = await this.#session.append(lines);
              if (added.length) this.#emit('step', { messages: added, usage: this.session.usage });
            },
            onPart: (part) => { feed.part(part); this.#emit('part', part); },
            onToolError: (name, error) => this.#emit('tool-error', { name, error }),
          });
        } catch (e) {
          feed.error((e as Error).message);
          await feed.end();
          throw e;
        }
        await feed.end();
        await this.#flushPartials();
        this.#emit('turn-end', r);
        return r;
      });
    } catch (e) {
      // A stop before the session was even taken: nothing was sent, nothing
      // recorded, the message dropped — the user said stop.
      if (signal.aborted) return nothing;
      throw e;
    } finally {
      this.#abort = null;
    }
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
      if (await this.#session.makeCurrent(start.recordMoved, signal)) this.#emit('reloaded', { messages: this.session.messages });
      await this.#flushPartials();
      this.#session.setPlanMode(start.planMode);
      const model = this.#model.resolve(start.config);
      const stored = this.session.row.system_prompt;
      if (!stored) throw new PhantomError('config_invalid', `session ${this.session.id} has no system prompt`);
      const { messages: system, uncached } = systemMessages(systemPromptBlocks(stored), model.spec.provider);
      if (uncached) this.#handlers.onNotice({ type: 'cache', text: `${uncached} system prompt block(s) beyond the first ${CACHED_BLOCKS} are not cached on ${model.spec.provider}` });
      this.#kits.add(serverToolKit(start.tools));
      const { tools, terminal } = await this.#kits.resolve({ backend: this.backend, sessionId: this.session.id, projectId: this.session.projectId,
        workspaceId: this.session.workspaceId, readonly: () => this.session.planMode });
      return { model, system, tools, terminal };
    } catch (e) {
      if (signal.aborted) return null;
      throw e;
    }
  }

  // ── wiring ─────────────────────────────────────────────────────────────

  /** After construction, once `type` exists (a subclass field lands after
   *  the base constructor ran). */
  #wire(): this {
    this.#model = new ModelHandle(this.backend, this.type, this.session.id, {
      retry: { ...MODEL_RETRY, ...this.#handlers.retry?.model },
      notice: (text) => this.#handlers.onNotice({ type: 'retry', text }),
      onBillingError: (e) => this.#handlers.onError(e),
    });
    return this;
  }

  /** Every awaited public call: the error reaches onError first, then the caller. */
  async #guard<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (e) {
      const pe = asPhantomError(e, 'internal', 'agent');
      this.#handlers.onError(pe);
      throw pe;
    }
  }

  #emit<E extends keyof AgentEvents>(event: E, payload: AgentEvents[E]): void {
    this.#events.emit(event, payload, (e) => this.#handlers.onError(asPhantomError(e, 'listener_threw', `a listener for "${event}" threw`)));
  }

  /** The one way an agent comes to be: the session id (made or given), the
   *  session read, the agent built and wired. Every failure reaches onError
   *  first, then the caller. */
  static async #build<T extends Agent>(ctor: AgentClass<T>, backend: BackendClient, handlers: AgentHandlers,
    sessionId: (b: BackendClient) => Promise<string>, what: string): Promise<T> {
    try {
      const b = backend.withRetry({ ...BACKEND_RETRY, ...handlers.retry?.backend }, (text) => handlers.onNotice({ type: 'retry', text }));
      return new ctor({ backend: b, handlers, session: await Session.load(b, handlers, await sessionId(b)) }).#wire();
    } catch (e) {
      const pe = asPhantomError(e, 'internal', what);
      handlers.onError(pe);
      throw pe;
    }
  }
}
