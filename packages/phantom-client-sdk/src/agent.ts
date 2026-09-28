// The base of every agent. A subclass says its type and how its system
// prompt is built — nothing else. The base wires the session (session.ts),
// the model (model/models.ts), the tools (toolkit.ts) and the turn
// (turn.ts), and owns the user's queue, interrupts and events.
//
//   class CodingAgent extends Agent {
//     readonly type = 'coding';
//     protected systemPrompt() { return [this.session.row.system_prompt as string]; }
//   }
//   const agent = await CodingAgent.open(backend, handlers, sessionId);
//
// Opening only reads: nothing is locked or written until a turn starts.
import type { PhantomBackend } from './backend.js';
import { PhantomError, asPhantomError } from './errors.js';
import { Emitter, type AgentEvents } from './events.js';
import { TurnFeed } from './feed.js';
import { systemMessages, CACHED_BLOCKS } from './model/cache.js';
import { Models, type ResolvedModel } from './model/models.js';
import type { Tool } from 'ai';
import { BACKEND_RETRY, MODEL_RETRY, type RetryPolicy } from './model/retry.js';
import { Session, type SessionInfo } from './session.js';
import { ToolKitSet, serverToolKit, type ToolKit } from './toolkit.js';
import { runTurn, type TurnResult } from './turn.js';
import { UserMessageQueue, type UserMessages } from './userMessages.js';

export interface Notice {
  kind: 'retry' | 'cache' | 'info';
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

/** What the base builds a subclass from — `open` / `create` are the only
 *  callers. Subclasses declare no constructor. */
interface AgentDeps { plain: PhantomBackend; backend: PhantomBackend; handlers: AgentHandlers; session: Session }
type AgentClass<T extends Agent> = new (deps: AgentDeps) => T;

export abstract class Agent {
  /** Which agent this is — the server answers its model and tools by type. */
  abstract readonly type: string;
  /** The prompt, as blocks, asked before every turn. */
  protected abstract systemPrompt(): Promise<string[]> | string[];

  /** The connection, retrying: a network failure or a 5xx is retried per
   *  the handlers' policy, each attempt a notice; 409s (locked, conflict)
   *  are facts and never retried. For a subclass's own calls too. */
  readonly backend: PhantomBackend;
  readonly session: SessionInfo;

  readonly #session: Session;
  /** The connection as given — the live feed is best-effort, and a minute
   *  of retries would only serve stale output. */
  readonly #plain: PhantomBackend;
  readonly #handlers: AgentHandlers;
  readonly #kits = new ToolKitSet();
  readonly #queue = new UserMessageQueue();
  readonly #events = new Emitter();
  #models!: Models;
  #turn: Promise<TurnResult> | null = null;
  #abort: AbortController | null = null;
  #closed = false;

  /** @internal — through `open` / `create` only. */
  constructor({ plain, backend, handlers, session }: AgentDeps) {
    this.#plain = plain;
    this.backend = backend;
    this.#handlers = handlers;
    this.#session = session;
    this.session = session;
  }

  // ── opening ────────────────────────────────────────────────────────────

  /** An existing session: the row as it stands, then the record. */
  static async open<T extends Agent>(this: AgentClass<T>, backend: PhantomBackend, handlers: AgentHandlers, sessionId: string): Promise<T> {
    return Agent.#build(this, backend, handlers, () => Promise.resolve(sessionId), `opening session ${sessionId}`);
  }

  /** A new session: the app makes the row its own way (the route is the
   *  app's) and answers its id; then as `open`. */
  static async create<T extends Agent>(this: AgentClass<T>, backend: PhantomBackend, handlers: AgentHandlers,
    createRow: (backend: PhantomBackend) => Promise<{ id: string }>): Promise<T> {
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
  use(kit: ToolKit): this { this.#kits.add(kit); return this; }

  /** The user's message: queued, then `run()`. No turn running → a turn
   *  starts with it and this resolves with the result. A turn running → the
   *  text rides its next model call, or continues the turn when the model
   *  has stopped; this resolves null. */
  send(text: string): Promise<TurnResult | null> {
    this.#queue.add(text);
    return this.run();
  }

  /** Start a turn from what is queued. Null when nothing is queued or a
   *  turn is running (the running one takes the queue). The way to go on
   *  after a stop, or after the session was busy elsewhere — the text stayed
   *  queued both times. */
  run(): Promise<TurnResult | null> {
    if (this.busy || !this.#queue.length) return Promise.resolve(null);
    if (this.#closed) return Promise.reject(new PhantomError('busy', 'the agent is closed'));
    const p = this.#guard(() => this.#turnBody());
    this.#turn = p;
    return p.finally(() => { if (this.#turn === p) this.#turn = null; });
  }

  /** Stop the running turn. Finished tool calls keep their results; queued
   *  text stays queued. Nothing starts after it on its own. */
  interrupt(): void { this.#abort?.abort(new Error('interrupted')); }

  async close(): Promise<void> {
    this.#closed = true;
    this.interrupt();
    if (this.#turn) await this.#turn.then(() => undefined, () => undefined);
  }

  // ── the turn ───────────────────────────────────────────────────────────
  // One turn = one lock = one result.

  async #turnBody(): Promise<TurnResult> {
    const abort = new AbortController();
    this.#abort = abort;
    try {
      return await this.#session.withLock(abort.signal, (e) => this.#handlers.onError(e), async ({ recordMoved }) => {
        const ready = await this.#prepare(recordMoved, abort.signal);
        if (!ready) return { text: '', messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, outcome: 'interrupted' };
        // The session is ours: what the turn opens with is the turn's from
        // here — the server's notes ahead of the user's words.
        const opening = [...ready.notes, ...this.#queue.drain()];
        this.#emit('turn-start', { texts: opening });
        const feed = new TurnFeed(this.#plain, this.session.id,
          { agent: this.type, message: opening.join('\n\n'), provider: ready.model.config.provider, model: ready.model.config.model },
          { onInterrupt: () => this.interrupt(), onRow: (patch) => this.#session.rowMoved(patch),
            onNotice: (text) => this.#handlers.onNotice({ kind: 'info', text }) });
        let r: TurnResult;
        try {
          r = await runTurn({
            model: ready.model.model, provider: ready.model.config.provider, modelId: ready.model.config.model, reasoning: ready.model.reasoning,
            system: systemMessages(ready.blocks), tools: ready.tools, history: this.session.messages, maxSteps: ready.model.config.maxSteps,
            signal: abort.signal, opening,
            pending: () => {
              const sent = this.#queue.drain();
              if (sent.length) this.#emit('user-message', { texts: sent });
              return sent;
            },
            record: async (lines) => {
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
        // The turn happened and is recorded: the answer stands whatever the
        // bookkeeping says. A failure there is reported, not thrown over it.
        try { await this.#session.turnEnded(); }
        catch (e) { this.#handlers.onError(asPhantomError(e, 'backend_error', 'marking the turn ended')); }
        this.#emit('turn-end', r);
        return r;
      });
    } finally {
      this.#abort = null;
    }
  }

  /** Everything a turn needs before it sends anything: the record made
   *  current, the row re-read, the model, the prompt, the tools, the
   *  server's notes. Null when a stop landed meanwhile — nothing was sent,
   *  nothing recorded, the queue untouched. */
  async #prepare(recordMoved: boolean, signal: AbortSignal): Promise<{ model: ResolvedModel; blocks: string[]; tools: Record<string, Tool>; notes: string[] } | null> {
    try {
      if (await this.#session.makeCurrent(recordMoved, signal)) this.#emit('reloaded', { messages: this.session.messages });
      await this.#session.refresh(signal);
      const model = await this.#models.resolve(signal);
      const blocks = await this.systemPrompt();
      if (model.config.provider === 'anthropic' && blocks.length > CACHED_BLOCKS) {
        this.#handlers.onNotice({ kind: 'cache', text: `the system prompt has ${blocks.length} blocks; only the first ${CACHED_BLOCKS} are cached on Anthropic` });
      }
      const tools = await this.#kits.resolve({ backend: this.backend, sessionId: this.session.id, workspaceId: this.session.workspaceId,
        folderId: this.session.folderId, readonly: () => this.session.planMode });
      const notes = await this.#session.takeNotes(signal);
      return { model, blocks, tools, notes };
    } catch (e) {
      if (signal.aborted) return null;
      throw e;
    }
  }

  // ── wiring ─────────────────────────────────────────────────────────────

  /** After construction, once `type` exists (a subclass field lands after
   *  the base constructor ran). */
  #wire(): this {
    this.#kits.add(serverToolKit(this.type));
    this.#models = new Models(this.backend, this.type, this.session.id, {
      retry: { ...MODEL_RETRY, ...this.#handlers.retry?.model },
      notice: (text) => this.#handlers.onNotice({ kind: 'retry', text }),
      onBillingError: (e) => this.#handlers.onError(e),
    });
    return this;
  }

  /** Every awaited public call: the error reaches onError first, then the caller. */
  async #guard<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (e) {
      const pe = asPhantomError(e, 'backend_error', 'agent');
      this.#handlers.onError(pe);
      throw pe;
    }
  }

  #emit<E extends keyof AgentEvents>(event: E, payload: AgentEvents[E]): void {
    this.#events.emit(event, payload, (e) => this.#handlers.onError(asPhantomError(e, 'backend_error', `a listener for "${event}" threw`)));
  }

  /** The one way an agent comes to be: the session id (made or given), the
   *  session read, the agent built and wired. Every failure reaches onError
   *  first, then the caller. */
  static async #build<T extends Agent>(ctor: AgentClass<T>, backend: PhantomBackend, handlers: AgentHandlers,
    sessionId: (b: PhantomBackend) => Promise<string>, what: string): Promise<T> {
    try {
      const b = backend.withRetry({ ...BACKEND_RETRY, ...handlers.retry?.backend }, (text) => handlers.onNotice({ kind: 'retry', text }));
      return new ctor({ plain: backend, backend: b, handlers, session: await Session.open(b, await sessionId(b)) }).#wire();
    } catch (e) {
      const pe = asPhantomError(e, 'backend_error', what);
      handlers.onError(pe);
      throw pe;
    }
  }
}
