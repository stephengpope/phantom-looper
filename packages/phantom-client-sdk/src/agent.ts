// The base of every agent. A subclass declares its kind, how its system
// prompt is built, and its default tool kits. The base owns everything else:
// creating and resuming a session, freezing the prompt on the row, tools,
// the turn, nudges and injections, interrupts, the transcript, billing,
// compaction, errors and notices.
//
// Which model a turn runs on is never kept here: every turn asks the server
// (GET /agents/:kind/config?session=), and the server applies its own rule.
// The transcript is shared — other windows, the server and Telegram write
// it too, one at a time under the session lock — so every turn starts by
// making sure its copy is the server's.
//
// Construction only through a subclass's `create` / `resume` (which call
// `birth` / `wake` here) — that is what guarantees the prompt is frozen
// before any turn can run.
import type { LanguageModel, ModelMessage, ToolCallPart } from 'ai';
import { call, type PhantomBackend } from './backend.js';
import { PhantomError, asPhantomError } from './errors.js';
import { Emitter, type AgentEvents } from './events.js';
import { systemMessages, CACHED_BLOCKS } from './model/cache.js';
import { llmConfigFrom, keysFrom, type AgentKeys, type LlmConfig, type Provider } from './model/llmConfig.js';
import { languageModel, billingMiddleware, effectiveReasoning, type ModelHooks, type ModelSpec, type TokenUsage } from './model/languageModel.js';
import { withRetry, BACKEND_RETRY, MODEL_RETRY, type RetryPolicy } from './model/retry.js';
import { wrapLanguageModel } from 'ai';
import { MessageQueue } from './queues.js';
import { ToolKitSet, type ToolKit, type ToolKitContext } from './toolkit.js';
import { Transcript, conversationFrom, messageLine, compactionLine, type TranscriptLine } from './transcript.js';
import { runTurn, type TurnResult, type PendingMessages } from './turn.js';
import { interruptedResultMessage } from './messages.js';
import { compactionDue, compactionStrategy, planCompaction, writeSummary } from './compaction.js';
import { Relay, watchForInterrupt } from './feed.js';

export interface Notice {
  kind: 'retry' | 'cache' | 'compacted' | 'info';
  text: string;
}

export interface AgentHandlers {
  /** Every error the SDK produces, once, with code and stack. Required. */
  onError(error: PhantomError): void;
  /** Non-error information: retries, cache limits, compaction. Required. */
  onNotice(notice: Notice): void;
  /** How hard to retry. Defaults: BACKEND_RETRY (~15s) for the backend,
   *  MODEL_RETRY (3 min) for providers. A client sets its own. */
  retry?: { backend?: Partial<RetryPolicy>; model?: Partial<RetryPolicy> };
}

/** The session row as the server answers it. */
export interface SessionRow {
  id: string;
  workspaceId: string;
  folderId: string | null;
  status: string;
  agent?: string | null;
  system_prompt?: string[] | null;
  [k: string]: unknown;
}

export interface TokenTotals { input: number; output: number; cacheRead: number; cacheWrite: number }

export type AgentCtor<T extends Agent> = new (backend: PhantomBackend, handlers: AgentHandlers, row: SessionRow) => T;

/** How often the lock is renewed while held. The server's TTL is minutes;
 *  a minute keeps a long tool inside it with room to spare. */
const LOCK_RENEW_MS = 60_000;

/** What taking the session lock answers. The transcript's last-changed mark
 *  rides along, so a turn knows whether its copy is current without
 *  downloading anything. */
interface LockReply { transcript_updated_at?: string | null }

export abstract class Agent {
  abstract readonly kind: string;
  /** The prompt, as blocks. Run ONCE at creation when frozen. */
  protected abstract systemPrompt(): Promise<string[]> | string[];
  protected abstract toolKits(): ToolKit[];
  /** Default: frozen on the row at creation. false = built at every turn, never saved. */
  protected systemPromptFrozen = true;

  readonly sessionId: string;
  readonly workspaceId: string;

  #backend: PhantomBackend;
  /** As given — no retries. The relay uses it: live output is best-effort,
   *  and a minute of retries would serve stale tokens. */
  #rawBackend: PhantomBackend;
  #handlers: AgentHandlers;
  #modelRetry: RetryPolicy;
  #row: SessionRow;
  #blocks: string[] = [];
  #transcript!: Transcript;
  #messages: ModelMessage[] = [];
  #ids: (string | null)[] = [];
  #usage: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  #kits = new ToolKitSet();
  #model: { key: string; model: LanguageModel } | null = null;
  /** Default: the row's plan mode, re-read at every turn start. A client
   *  with a live flag (the cli's /plan mid-turn) overrides with setReadonly. */
  #readonly: () => boolean = () => this.#row.planMode === true;
  #nudges = new MessageQueue();
  #injections = new MessageQueue();
  /** Pull the server's queued notes into each turn (setServerNotes). */
  #serverNotes = true;
  #events = new Emitter();
  #turn: Promise<TurnResult & { llm: LlmConfig }> | null = null;
  #abort: AbortController | null = null;
  #compacting: Promise<unknown> | null = null;
  #closed = false;

  protected constructor(backend: PhantomBackend, handlers: AgentHandlers, row: SessionRow) {
    this.#handlers = handlers;
    this.#rawBackend = backend;
    this.#modelRetry = { ...MODEL_RETRY, ...handlers.retry?.model };
    // Every backend call retries on a network failure or a 5xx, each attempt
    // a notice. 409s (locked, conflict) are facts and never retried.
    const backendRetry: RetryPolicy = { ...BACKEND_RETRY, ...handlers.retry?.backend };
    this.#backend = { ...backend, fetch: withRetry(backend.fetch, (text) => handlers.onNotice({ kind: 'retry', text }), backendRetry) };
    this.#row = row;
    this.sessionId = row.id;
    this.workspaceId = row.workspaceId;
    // A pending nudge (a voice note) settled while idle: it starts a turn.
    this.#nudges.onSettled = (_entry, error) => {
      if (error !== undefined) {
        this.#handlers.onError(asPhantomError(error, 'backend_error', 'a queued message failed'));
        return;
      }
      if (!this.busy && !this.#closed && this.#nudges.ready) this.#background('follow-up turn', () => this.#runTurn());
    };
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

  /** A subclass's `resume`. A swept session (its container gone) is
   *  restarted under the same id. */
  protected static async wake<T extends Agent>(
    ctor: unknown, backend: PhantomBackend, handlers: AgentHandlers, sessionId: string,
  ): Promise<T> {
    let agent: T;
    try {
      let row = await call<SessionRow>(backend, 'GET', `/sessions/${sessionId}`);
      if (row.status !== 'active') {
        row = await call<SessionRow>(backend, 'POST', '/sessions', { workspace_id: row.workspaceId, id: sessionId });
      }
      agent = new (ctor as AgentCtor<T>)(backend, handlers, row);
    } catch (e) {
      const pe = asPhantomError(e, 'session_not_found', `resuming session ${sessionId}`);
      handlers.onError(pe);
      throw pe;
    }
    await agent.#guard(() => agent.#open());
    return agent;
  }

  /** Kits, then freeze the prompt (once — a row that already holds one
   *  keeps it), then read the record. */
  async #open(): Promise<void> {
    for (const kit of this.toolKits()) this.#kits.add(kit);
    if (this.systemPromptFrozen) {
      const stored = this.#row.system_prompt;
      if (Array.isArray(stored) && stored.length) this.#blocks = stored;
      else {
        const blocks = await this.systemPrompt();
        await this.#withLock('freezing the prompt', () =>
          call(this.#backend, 'PUT', `/sessions/${this.sessionId}/frozen`, { systemPrompt: blocks }).then(() => undefined));
        this.#blocks = blocks;
      }
    }
    this.#seat(await Transcript.load(this.#backend, this.sessionId));
    // Opening is reading: the lock is taken only when a cut step must be
    // answered in the record.
    if (danglingCalls(this.#messages).length) {
      await this.#withLock('answering interrupted calls', (lock) => this.#current(lock));
    }
  }

  /** Take a copy of the record as the one this agent works from. */
  #seat(t: Transcript): void {
    this.#transcript = t;
    this.#rebuild();
    this.#usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const l of t.lines) {
      if (l.type !== 'usage') continue;
      this.#usage.input += l.input; this.#usage.output += l.output;
      this.#usage.cacheRead += l.cacheRead; this.#usage.cacheWrite += l.cacheWrite;
    }
  }

  /** The conversation the next model call is built from, from the record. */
  #rebuild(): void {
    const c = conversationFrom(this.#transcript.lines);
    this.#messages = c.messages;
    this.#ids = c.ids;
  }

  /** Under the lock: make this copy the server's. Someone else (another
   *  window, the server, Telegram) may have added to the transcript since
   *  this agent last looked — then it is read again, whole. A step left cut
   *  (tool calls with no results) is answered after. */
  async #current(lock: LockReply): Promise<void> {
    if ((lock.transcript_updated_at ?? null) !== this.#transcript.stamp) {
      this.#seat(await Transcript.load(this.#backend, this.sessionId));
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
    await this.#append(calls.map((c) => messageLine(interruptedResultMessage(c))));
  }

  /** The model settings and keys for this agent, as the server resolves them
   *  now — for this session, on the server's own rule. Nothing is kept. */
  async #resolveLlm(): Promise<{ llm: LlmConfig; keys: AgentKeys }> {
    const raw = await call(this.#backend, 'GET', `/agents/${this.kind}/config?session=${encodeURIComponent(this.sessionId)}`);
    return { llm: llmConfigFrom(raw), keys: keysFrom(raw) };
  }

  /** Test seam: a subclass may hand back a mock. Production builds the real one. */
  protected buildModel(spec: ModelSpec, hooks: ModelHooks): LanguageModel {
    return languageModel(spec, hooks);
  }

  // ── public state ───────────────────────────────────────────────────────

  get messages(): readonly ModelMessage[] { return this.#messages; }
  get usage(): Readonly<TokenTotals> { return this.#usage; }
  get busy(): boolean { return this.#turn !== null; }
  get systemPromptBlocks(): readonly string[] { return this.#blocks; }
  get nudges(): MessageQueue { return this.#nudges; }
  get injections(): MessageQueue { return this.#injections; }
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
  /** Pull the server's queued notes (a background command finished, instant
   *  sync) into each turn. On by default. */
  setServerNotes(on: boolean): void { this.#serverNotes = on; }

  // ── talking ────────────────────────────────────────────────────────────

  /** The builder's words. No turn running → runs one and resolves with its
   *  result. Turn running → queued: rides the next model call; still queued
   *  when the turn ends → starts the next turn. Resolves null when queued. */
  say(text: string | Promise<string | null>): Promise<TurnResult | null> {
    if (typeof text === 'string') this.#nudges.add(text);
    else this.#nudges.addPending(text);
    if (this.busy) return Promise.resolve(null);
    if (!this.#nudges.ready) return Promise.resolve(null);   // a pending voice note: onSettled starts the turn
    return this.#guard(() => this.#runTurn());
  }

  /** A system fact. Never starts a turn: rides the next model call of a
   *  running turn, or goes in ahead of the next nudge. */
  inject(text: string): void { this.#injections.add(text); }

  /** Stop the running turn. Nothing starts after it on its own: whatever is
   *  still queued waits for the app to say what happens next. */
  interrupt(): void { this.#abort?.abort(new Error('interrupted')); }

  async close(): Promise<void> {
    this.#closed = true;
    this.interrupt();
    if (this.#turn) await this.#turn.then(() => undefined, () => undefined);
    if (this.#compacting) await this.#compacting.then(() => undefined, () => undefined);
  }

  // ── the turn ───────────────────────────────────────────────────────────

  #runTurn(): Promise<TurnResult & { llm: LlmConfig }> {
    if (this.#turn) return Promise.reject(new PhantomError('busy', 'a turn is already running'));
    if (this.#closed) return Promise.reject(new PhantomError('busy', 'the agent is closed'));
    const p = this.#turnBody();
    this.#turn = p;
    return p.finally(() => { if (this.#turn === p) this.#turn = null; })
      .then((result) => { this.#afterTurn(result); return result; });
  }

  /** After the turn, never inside it: compaction, then whatever is still
   *  queued — only after a turn that finished on its own. Not after a stop
   *  (the app decides what comes next) and not after a failure. */
  #afterTurn(result: TurnResult & { llm: LlmConfig }): void {
    const c = result.llm.compaction;
    if (compactionDue(result.lastInputTokens, c.contextWindow, c.thresholdPct)) {
      this.#background('compaction', () => this.#compact());
    }
    if (result.outcome === 'done' && this.#nudges.ready && !this.#closed) {
      this.#background('follow-up turn', () => this.#runTurn());
    }
  }

  async #turnBody(): Promise<TurnResult & { llm: LlmConfig }> {
    if (this.#compacting) await this.#compacting.then(() => undefined, () => undefined);
    const abort = new AbortController();
    this.#abort = abort;
    // The builder's words this turn starts with are the turn's from here:
    // if it fails, they fail with it — nothing is kept or sent again.
    const opening = this.#takeNudges();
    // The server's notes this turn took, until the record holds them. A turn
    // that fails first hands them back: they are facts the next turn is owed.
    let notes: string[] = [];
    let notesOwed = false;
    try {
      return await this.#withLock('the turn', async (lock) => {
        await this.#current(lock);
        // The row as it stands now: plan mode, the folder the tools open.
        this.#row = await call<SessionRow>(this.#backend, 'GET', `/sessions/${this.sessionId}`);
        if (this.#serverNotes) {
          const drained = await call<{ messages?: string[] }>(this.#backend, 'POST', `/sessions/${this.sessionId}/backdoor/drain`);
          notes = drained.messages ?? [];
          notesOwed = notes.length > 0;
        }

        const blocks = this.systemPromptFrozen ? this.#blocks : await this.systemPrompt();
        const { llm, keys } = await this.#resolveLlm();
        const model = this.#modelFor(llm, keys.model);
        const tools = await this.#kits.resolve(this.#kitContext());
        this.#noticeCacheLimit(blocks, llm.provider);

        const injected = this.#injections.all().filter((e) => e.settled && !e.failed).map((e) => e.text!);
        const texts = [...notes, ...injected, ...opening];
        this.#emit('turn-start', { texts });
        // The feed, both ways: watchers see this turn as it runs; a stop
        // from anywhere ends it.
        const relay = new Relay(this.#rawBackend, this.sessionId,
          (reason) => this.#handlers.onNotice({ kind: 'info', text: `live relay stopped for this turn (${reason}) — watchers see the record when it lands` }));
        const unwatch = watchForInterrupt(this.#rawBackend, this.sessionId, () => this.interrupt(),
          (reason) => this.#handlers.onNotice({ kind: 'info', text: `not listening for a remote stop this turn (${reason})` }));
        relay.turnStart({ agent: this.kind, message: texts.join('\n\n'), provider: llm.provider, model: llm.model });
        // The first model call carries the notes and the opening words.
        let first: { notes: string[]; opening: string[] } | null = { notes, opening };
        let r: TurnResult;
        try {
          r = await runTurn({
            model, provider: llm.provider, modelId: llm.model,
            system: systemMessages(blocks),
            tools, history: this.#messages, maxSteps: llm.maxSteps,
            reasoning: effectiveReasoning({ provider: llm.provider, model: llm.model, endpoint: llm.endpoint, reasoning: llm.reasoning, apiKey: null }),
            signal: abort.signal,
            pending: () => {
              const p = this.#pending(first, () => { notesOwed = false; });
              first = null;
              return p;
            },
            record: (lines) => this.#append(lines),
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
        return { ...r, llm };
      });
    } catch (e) {
      if (notesOwed) {
        this.#background('handing the server\'s notes back', () =>
          call(this.#backend, 'POST', `/sessions/${this.sessionId}/backdoor/restore`, { messages: notes }).then(() => undefined));
      }
      throw e;
    } finally {
      this.#abort = null;
    }
  }

  /** Every ready nudge from the front, taken. A voice note that failed is
   *  reported and dropped. */
  #takeNudges(): string[] {
    const nud = this.#nudges.drain();
    for (const f of nud.failed) this.#handlers.onError(asPhantomError(f.error, 'backend_error', 'a queued message failed'));
    return nud.texts;
  }

  /** What rides into the next model call: the server's notes and the
   *  opening words (first call only), injections, then any nudge typed
   *  since. If the call they rode fails, injections go back in line — they
   *  are facts the next turn still needs; the builder's words do not. */
  #pending(first: { notes: string[]; opening: string[] } | null, onSaved: () => void): PendingMessages {
    const inj = this.#injections.drain();
    const nudges = [...(first?.opening ?? []), ...this.#takeNudges()];
    if (nudges.length) this.#emit('nudge', { texts: nudges });
    return {
      texts: [...(first?.notes ?? []), ...inj.texts, ...nudges],
      commit: onSaved,
      restore: () => { this.#injections.restore(inj.entries); },
    };
  }

  async #append(lines: TranscriptLine[]): Promise<void> {
    await this.#transcript.append(lines);
    const msgs: ModelMessage[] = [];
    for (const l of lines) {
      if (l.type !== 'message') continue;
      this.#messages.push(l.message); this.#ids.push(l.id); msgs.push(l.message);
    }
    if (msgs.length) this.#emit('step', { messages: msgs, usage: this.#usage });
  }

  #kitContext(): ToolKitContext {
    return { backend: this.#backend, sessionId: this.sessionId, workspaceId: this.workspaceId,
      folderId: this.#row.folderId, readonly: () => this.#readonly() };
  }

  #modelFor(llm: LlmConfig, apiKey: string | null): LanguageModel {
    const spec: ModelSpec = { provider: llm.provider, model: llm.model, endpoint: llm.endpoint, reasoning: llm.reasoning, apiKey };
    const key = JSON.stringify(spec);
    if (this.#model?.key !== key) this.#model = { key, model: this.#billed(this.buildModel(spec, this.#modelHooks()), spec) };
    return this.#model.model;
  }

  /** Every model handle is billed here, whatever built it: usage is read
   *  where the AI SDK reads it and posted to /log-tokens. */
  #billed(model: LanguageModel, spec: ModelSpec): LanguageModel {
    return wrapLanguageModel({ model: model as Exclude<LanguageModel, string>, middleware: billingMiddleware(spec, this.#modelHooks().usage) });
  }

  #modelHooks(): ModelHooks {
    return {
      notice: (text) => this.#handlers.onNotice({ kind: 'retry', text }),
      retry: this.#modelRetry,
      usage: (u: TokenUsage) => this.#background('billing', () =>
        call(this.#backend, 'POST', '/log-tokens', { kind: this.kind, sessionId: this.sessionId, ...u }).then(() => undefined)),
    };
  }

  #noticeCacheLimit(blocks: readonly string[], provider: Provider): void {
    if (provider === 'anthropic' && blocks.length > CACHED_BLOCKS) {
      this.#handlers.onNotice({ kind: 'cache',
        text: `the system prompt has ${blocks.length} blocks; only the first ${CACHED_BLOCKS} are cached on Anthropic` });
    }
  }

  // ── compaction ─────────────────────────────────────────────────────────

  /** Summarize the oldest part of the conversation now. Null when there is
   *  too little to compact or one is already running. */
  compact(): Promise<{ removed: number; summary: string } | null> {
    return this.#guard(() => this.#compact());
  }

  #compact(): Promise<{ removed: number; summary: string } | null> {
    if (this.#compacting) return Promise.resolve(null);
    const p = this.#compactBody();
    this.#compacting = p;
    return p.finally(() => { if (this.#compacting === p) this.#compacting = null; });
  }

  async #compactBody(): Promise<{ removed: number; summary: string } | null> {
    if (this.#turn) await this.#turn.then(() => undefined, () => undefined);
    const { llm, keys } = await this.#resolveLlm();
    const c = llm.compaction;
    const first = this.#messages[0];
    const prior = this.#ids[0] === null && first && typeof first.content === 'string' ? first.content : null;
    const plan = planCompaction(this.#messages, compactionStrategy(c.strategy), c.summarizePct, prior);
    if (!plan) return null;
    // The summary model's own key, from the same answer — its provider may
    // not be the agent's.
    const spec: ModelSpec = { provider: c.model.provider, model: c.model.model, endpoint: c.model.endpoint,
      reasoning: c.model.reasoning, apiKey: keys.compaction };
    const model = this.#billed(this.buildModel(spec, this.#modelHooks()), spec);
    const summary = await writeSummary(model, plan, c.maxTokens);
    const firstKeptId = this.#ids[plan.removeCount] ?? '';
    // The record only grows, so the kept tail's first line is still where it
    // was even if someone added to the transcript meanwhile: bring the copy
    // current, append, and rebuild the conversation from the record.
    await this.#withLock('compaction', async (lock) => {
      await this.#current(lock);
      await this.#transcript.append([compactionLine(summary, firstKeptId)]);
    });
    this.#rebuild();
    this.#emit('compacted', { removed: plan.removeCount, summary });
    this.#handlers.onNotice({ kind: 'compacted', text: `compacted: ${plan.removeCount} messages summarized` });
    return { removed: plan.removeCount, summary };
  }

  // ── the lock ───────────────────────────────────────────────────────────

  async #withLock<T>(label: string, fn: (lock: LockReply) => Promise<T>): Promise<T> {
    const lock = await call<LockReply>(this.#backend, 'POST', `/sessions/${this.sessionId}/lock`, { label });
    const renew = setInterval(() => {
      this.#background('lock renewal', () => call(this.#backend, 'POST', `/sessions/${this.sessionId}/ping`).then(() => undefined));
    }, LOCK_RENEW_MS);
    try {
      return await fn(lock ?? {});
    } finally {
      clearInterval(renew);
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
