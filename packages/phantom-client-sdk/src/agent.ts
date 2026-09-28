// The base of every agent. A subclass declares its kind, how its system
// prompt is built, and its default tool kits. The base owns everything else:
// creating and resuming a session, tools, the turn, the user's messages,
// interrupts, the transcript, billing, errors and notices.
//
// The prompt is the subclass's: `systemPrompt()` is asked before every turn
// and nothing is stored here.
//
// Which model a turn runs on is never kept here: every turn asks the server
// (GET /agents/:kind/config?session=), and the server applies its own rule.
// The transcript is shared — other windows, the server and Telegram write
// it too, one at a time under the session lock — so every turn starts by
// making sure its copy is the server's.
//
// Construction only through a subclass's `create` / `resume` (which call
// `birth` / `wake` here) — that is what guarantees the record is read
// before any turn can run. Opening only reads: nothing is locked or
// written until a turn starts.
import type { LanguageModel, ModelMessage, ToolCallPart } from 'ai';
import { call, type PhantomBackend } from './backend.js';
import { PhantomError, asPhantomError } from './errors.js';
import { Emitter, type AgentEvents } from './events.js';
import { systemMessages, CACHED_BLOCKS } from './model/cache.js';
import { llmConfigFrom, type LlmConfig, type Provider } from './model/llmConfig.js';
import { billedModel, effectiveReasoning, type ModelSpec } from './model/languageModel.js';
import { withRetry, BACKEND_RETRY, MODEL_RETRY, type RetryPolicy } from './model/retry.js';
import { ClientUserMessageQueue } from './clientUserMessageQueue.js';
import { ToolKitSet, type ToolKit, type ToolKitContext } from './toolkit.js';
import { Transcript, conversationFrom, messageLine, type TranscriptLine } from './transcript.js';
import { runTurn, type TurnResult } from './turn.js';
import { interruptedResultMessage } from './messages.js';
import { Relay, watchForInterrupt } from './feed.js';

export interface Notice {
  kind: 'retry' | 'cache' | 'info';
  text: string;
}

export interface AgentHandlers {
  /** Every error the SDK produces, once, with code and stack. Required. */
  onError(error: PhantomError): void;
  /** Non-error information: retries, cache limits. Required. */
  onNotice(notice: Notice): void;
  /** How hard to retry. Defaults: BACKEND_RETRY (~15s) for the backend,
   *  MODEL_RETRY (3 min) for providers. A client sets its own. */
  retry?: { backend?: Partial<RetryPolicy>; model?: Partial<RetryPolicy> };
  /** The two tool results the runtime writes in a tool's place — for the
   *  model to read. Plain factual defaults; an app may word its own. */
  texts?: { readonlyRefusal?: (tool: string) => string; interrupted?: string };
}

/** The session row as the server answers it. `system_prompt` is whatever
 *  the app stores there, read by its own subclass. */
export interface SessionRow {
  id: string;
  workspaceId: string;
  folderId: string | null;
  status: string;
  agent?: string | null;
  system_prompt?: unknown;
  [k: string]: unknown;
}

export interface TokenTotals { input: number; output: number; cacheRead: number; cacheWrite: number }

export type AgentCtor<T extends Agent> = new (backend: PhantomBackend, handlers: AgentHandlers, row: SessionRow) => T;

/** What taking the session lock answers. The transcript's last-changed mark
 *  rides along, so a turn knows whether its copy is current without
 *  downloading anything. */
interface LockReply { transcript_updated_at?: string | null }

export abstract class Agent {
  abstract readonly kind: string;
  /** The prompt, as blocks, asked before every turn. */
  protected abstract systemPrompt(): Promise<string[]> | string[];
  protected abstract toolKits(): ToolKit[];

  readonly sessionId: string;
  readonly workspaceId: string;

  #backend: PhantomBackend;
  /** As given — no retries. The relay uses it: live output is best-effort,
   *  and a minute of retries would serve stale tokens. */
  #rawBackend: PhantomBackend;
  #handlers: AgentHandlers;
  #modelRetry: RetryPolicy;
  #row: SessionRow;
  #transcript!: Transcript;
  #messages: ModelMessage[] = [];
  #usage: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  #kits = new ToolKitSet();
  #model: { key: string; model: LanguageModel } | null = null;
  /** Default: the row's plan mode, re-read at every turn start. A client
   *  with a live flag overrides with setReadonly. */
  #readonly: () => boolean = () => this.#row.planMode === true;
  #userMessages = new ClientUserMessageQueue();
  #events = new Emitter();
  #turn: Promise<TurnResult> | null = null;
  #abort: AbortController | null = null;
  #closed = false;

  protected constructor(backend: PhantomBackend, handlers: AgentHandlers, row: SessionRow) {
    this.#handlers = handlers;
    this.#rawBackend = backend;
    this.#modelRetry = { ...MODEL_RETRY, ...handlers.retry?.model };
    // Every backend call retries on a network failure or a 5xx, each attempt
    // a notice. 409s (locked, conflict) are facts and never retried.
    const backendRetry: RetryPolicy = { ...BACKEND_RETRY, ...handlers.retry?.backend };
    this.#backend = { ...backend, fetch: withRetry(backend.fetch, (text) => handlers.onNotice({ kind: 'retry', text }), 'server', backendRetry) };
    this.#row = row;
    this.sessionId = row.id;
    this.workspaceId = row.workspaceId;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  /** A subclass's `create`: it makes the row its own way and hands it here. */
  protected static async birth<T extends Agent>(
    ctor: unknown, backend: PhantomBackend, handlers: AgentHandlers, createRow: () => Promise<SessionRow>,
  ): Promise<T> {
    let agent: T;
    try {
      const row = await createRow();
      agent = new (ctor as AgentCtor<T>)(backend, handlers, row);
    } catch (e) {
      const pe = asPhantomError(e, 'backend_error', 'creating the session');
      handlers.onError(pe);
      throw pe;
    }
    await agent.#guard(() => agent.#open());
    return agent;
  }

  /** A subclass's `resume`: the row as it stands, then the record. */
  protected static async wake<T extends Agent>(
    ctor: unknown, backend: PhantomBackend, handlers: AgentHandlers, sessionId: string,
  ): Promise<T> {
    let agent: T;
    try {
      const row = await call<SessionRow>(backend, 'GET', `/sessions/${sessionId}`);
      agent = new (ctor as AgentCtor<T>)(backend, handlers, row);
    } catch (e) {
      const pe = asPhantomError(e, 'backend_error', `resuming session ${sessionId}`);
      handlers.onError(pe);
      throw pe;
    }
    await agent.#guard(() => agent.#open());
    return agent;
  }

  /** Kits, then read the record. */
  async #open(): Promise<void> {
    for (const kit of this.toolKits()) this.#kits.add(kit);
    this.#seat(await Transcript.load(this.#backend, this.sessionId));
  }

  /** Take a copy of the record as the one this agent works from. */
  #seat(t: Transcript): void {
    this.#transcript = t;
    this.#messages = conversationFrom(t.lines).messages;
    this.#usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const l of t.lines) {
      if (l.type !== 'usage') continue;
      this.#usage.input += l.input; this.#usage.output += l.output;
      this.#usage.cacheRead += l.cacheRead; this.#usage.cacheWrite += l.cacheWrite;
    }
  }

  /** Under the lock: make this copy the server's. Someone else (another
   *  window, the server, Telegram) may have added to the transcript since
   *  this agent last looked — then the lines after ours are read and added.
   *  A step left cut (tool calls with no results) is answered after. */
  async #current(lock: LockReply): Promise<void> {
    if ((lock.transcript_updated_at ?? null) !== this.#transcript.stamp) {
      await this.#transcript.catchUp();
      this.#messages = conversationFrom(this.#transcript.lines).messages;
      this.#emit('reloaded', { messages: this.#messages });
    }
    await this.#answerDanglingCalls();
  }

  /** A crash mid-step left tool calls without results: answer them as
   *  interrupted so the next call is one the provider accepts. Called with
   *  the lock held. */
  async #answerDanglingCalls(): Promise<void> {
    const calls = danglingCalls(this.#messages);
    if (!calls.length) return;
    await this.#append(calls.map((c) => messageLine(interruptedResultMessage(c, this.#handlers.texts?.interrupted))));
  }

  /** The model this agent runs on, as the server resolves it now — for
   *  this session, on the server's own rule. Nothing is kept. */
  async #resolveLlm(): Promise<LlmConfig> {
    return llmConfigFrom(await call(this.#backend, 'GET', `/agents/${this.kind}/config?session=${encodeURIComponent(this.sessionId)}`));
  }

  // ── public state ───────────────────────────────────────────────────────

  get messages(): readonly ModelMessage[] { return this.#messages; }
  get usage(): Readonly<TokenTotals> { return this.#usage; }
  get busy(): boolean { return this.#turn !== null; }
  get userMessages(): ClientUserMessageQueue { return this.#userMessages; }
  get row(): Readonly<SessionRow> { return this.#row; }
  /** For a subclass's prompt building and kits. */
  protected get backend(): PhantomBackend { return this.#backend; }
  protected get handlers(): AgentHandlers { return this.#handlers; }
  /** The row moved (a follow, a rename): keep the copy current. The next
   *  turn's kits see the new folder through their version. */
  protected updateRow(row: SessionRow): void { this.#row = row; }

  on<E extends keyof AgentEvents>(event: E, fn: (payload: AgentEvents[E]) => void): () => void {
    return this.#events.on(event, fn);
  }

  use(kit: ToolKit): this { this.#kits.add(kit); return this; }
  setReadonly(fn: () => boolean): void { this.#readonly = fn; }

  // ── talking ────────────────────────────────────────────────────────────

  /** The user's message. No turn running → starts one and resolves with its
   *  result. Turn running → queued: rides the next model call; still queued
   *  when the turn ends → starts the next turn. Resolves null when queued.
   *  One call for both, decided at the moment of the call — so a message
   *  sent just as a turn ends is never left waiting with nothing to run it. */
  sendUserMessage(text: string): Promise<TurnResult | null> {
    this.#userMessages.add(text);
    if (this.busy) return Promise.resolve(null);
    return this.#guard(() => this.#runTurn());
  }

  /** Stop the running turn. Nothing starts after it on its own: whatever is
   *  still queued waits for the app to say what happens next. */
  interrupt(): void { this.#abort?.abort(new Error('interrupted')); }

  async close(): Promise<void> {
    this.#closed = true;
    this.interrupt();
    if (this.#turn) await this.#turn.then(() => undefined, () => undefined);
  }

  // ── the turn ───────────────────────────────────────────────────────────

  #runTurn(): Promise<TurnResult> {
    if (this.#turn) return Promise.reject(new PhantomError('busy', 'a turn is already running'));
    if (this.#closed) return Promise.reject(new PhantomError('busy', 'the agent is closed'));
    const p = this.#turnBody();
    this.#turn = p;
    return p.finally(() => { if (this.#turn === p) this.#turn = null; })
      .then((result) => { this.#afterTurn(result); return result; });
  }

  /** After the turn, never inside it: whatever is still queued — only after
   *  a turn that finished on its own. Not after a stop (the app decides what
   *  comes next) and not after a failure. */
  #afterTurn(result: TurnResult): void {
    if (result.outcome === 'done' && this.#userMessages.length && !this.#closed) {
      this.#background('follow-up turn', () => this.#runTurn());
    }
  }

  async #turnBody(): Promise<TurnResult> {
    const abort = new AbortController();
    this.#abort = abort;
    try {
      return await this.#withLock(async (lock) => {
        await this.#current(lock);
        // The session is ours: the user's messages this turn starts with are
        // the turn's from here — if it fails, they fail with it. Taken only
        // now, so a session held elsewhere leaves them queued.
        const opening = this.#userMessages.drain();
        // The row as it stands now: plan mode, the folder the tools open.
        this.#row = await call<SessionRow>(this.#backend, 'GET', `/sessions/${this.sessionId}`);
        // Messages the server held for this session are already in the
        // transcript: it writes them when the lock is taken, and #current
        // above read them.

        const llm = await this.#resolveLlm();
        const blocks = await this.systemPrompt();
        const model = this.#modelFor(llm);
        const tools = await this.#kits.resolve(this.#kitContext());
        this.#noticeCacheLimit(blocks, llm.provider);

        const texts = opening;
        this.#emit('turn-start', { texts });
        // The feed, both ways: watchers see this turn as it runs; a stop
        // from anywhere ends it.
        const relay = new Relay(this.#rawBackend, this.sessionId,
          (reason) => this.#handlers.onNotice({ kind: 'info', text: `live relay stopped for this turn (${reason}) — watchers see the record when it lands` }));
        const unwatch = watchForInterrupt(this.#rawBackend, this.sessionId, () => this.interrupt(),
          (reason) => this.#handlers.onNotice({ kind: 'info', text: `not listening for a remote stop this turn (${reason})` }));
        relay.turnStart({ agent: this.kind, message: texts.join('\n\n'), provider: llm.provider, model: llm.model });
        // The first model call carries the opening words;
        // every later one, whatever the user sent since.
        let first: string[] | null = texts;
        let r: TurnResult;
        try {
          r = await runTurn({
            model, provider: llm.provider, modelId: llm.model,
            system: systemMessages(blocks),
            tools, history: this.#messages, maxSteps: llm.maxSteps,
            reasoning: effectiveReasoning(llm),
            signal: abort.signal,
            pending: () => {
              const sent = this.#userMessages.drain();
              if (sent.length) this.#emit('user-message', { texts: sent });
              const out = [...(first ?? []), ...sent];
              first = null;
              return out;
            },
            record: (lines) => this.#append(lines),
            interruptedText: this.#handlers.texts?.interrupted,
            onPart: (part) => { relay.part(part); this.#emit('part', part); },
            onToolError: (name, error) => this.#emit('tool-error', { name, error }),
          });
        } catch (e) {
          relay.error((e as Error).message);
          await relay.turnEnd();
          throw e;
        } finally {
          unwatch();
        }
        await relay.turnEnd();
        this.#usage.input += r.usage.input; this.#usage.output += r.usage.output;
        this.#usage.cacheRead += r.usage.cacheRead; this.#usage.cacheWrite += r.usage.cacheWrite;
        await call(this.#backend, 'POST', `/sessions/${this.sessionId}/turn-ended`);
        this.#emit('turn-end', r);
        return r;
      });
    } finally {
      this.#abort = null;
    }
  }

  async #append(lines: TranscriptLine[]): Promise<void> {
    await this.#transcript.append(lines);
    const msgs: ModelMessage[] = [];
    for (const l of lines) {
      if (l.type !== 'message') continue;
      this.#messages.push(l.message); msgs.push(l.message);
    }
    if (msgs.length) this.#emit('step', { messages: msgs, usage: this.#usage });
  }

  #kitContext(): ToolKitContext {
    return { backend: this.#backend, sessionId: this.sessionId, workspaceId: this.workspaceId,
      folderId: this.#row.folderId, readonly: () => this.#readonly(), readonlyRefusal: this.#handlers.texts?.readonlyRefusal };
  }

  /** The model handle for this turn's config, billed to this session as
   *  this kind. Rebuilt only when the config moved. */
  #modelFor(llm: LlmConfig): LanguageModel {
    const spec: ModelSpec = { provider: llm.provider, model: llm.model, endpoint: llm.endpoint, reasoning: llm.reasoning, apiKey: llm.apiKey };
    const key = JSON.stringify(spec);
    if (this.#model?.key !== key) {
      this.#model = { key, model: billedModel(this.#backend, spec, { kind: this.kind, sessionId: this.sessionId }, {
        notice: (text) => this.#handlers.onNotice({ kind: 'retry', text }),
        retry: this.#modelRetry,
        onBillingError: (e) => this.#handlers.onError(e),
      }) };
    }
    return this.#model.model;
  }

  #noticeCacheLimit(blocks: readonly string[], provider: Provider): void {
    if (provider === 'anthropic' && blocks.length > CACHED_BLOCKS) {
      this.#handlers.onNotice({ kind: 'cache',
        text: `the system prompt has ${blocks.length} blocks; only the first ${CACHED_BLOCKS} are cached on Anthropic` });
    }
  }

  // ── the lock ───────────────────────────────────────────────────────────
  // Held for the turn. The server renews the hold on the turn's own writes.

  async #withLock<T>(fn: (lock: LockReply) => Promise<T>): Promise<T> {
    const lock = await call<LockReply>(this.#backend, 'POST', `/sessions/${this.sessionId}/lock`,
      { label: this.#backend.label ?? this.#backend.clientId });
    try {
      return await fn(lock ?? {});
    } finally {
      // The release runs even when fn threw; a release that fails is
      // reported, never thrown over the real error.
      try { await call(this.#backend, 'DELETE', `/sessions/${this.sessionId}/lock`); }
      catch (e) { this.#handlers.onError(asPhantomError(e, 'backend_error', 'releasing the session lock')); }
    }
  }

  // ── errors ─────────────────────────────────────────────────────────────

  /** Every awaited public call: the error reaches onError first, then the caller. */
  async #guard<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); }
    catch (e) {
      const pe = asPhantomError(e, 'backend_error', 'agent');
      this.#handlers.onError(pe);
      throw pe;
    }
  }

  /** THE one way background work starts: its failure reaches onError. */
  #background(label: string, fn: () => Promise<unknown>): void {
    fn().then(() => undefined, (e: unknown) => this.#handlers.onError(asPhantomError(e, 'backend_error', label)));
  }

  #emit<E extends keyof AgentEvents>(event: E, payload: AgentEvents[E]): void {
    this.#events.emit(event, payload, (e) => this.#handlers.onError(asPhantomError(e, 'backend_error', `a listener for "${event}" threw`)));
  }
}

/** The tool calls of the last message that never got a result — what a
 *  step cut by a crash leaves behind. */
function danglingCalls(messages: readonly ModelMessage[]): ToolCallPart[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || typeof last.content === 'string') return [];
  return last.content.filter((p): p is ToolCallPart => p.type === 'tool-call');
}
