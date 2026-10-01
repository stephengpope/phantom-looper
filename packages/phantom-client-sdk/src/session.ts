// The session as the server holds it, seen from one client: the row, the
// record, the lock, and the calls a turn makes around them. The ONLY thing in
// the runtime that talks to /sessions/*. What an app may read is
// `SessionInfo`; the Agent drives the rest.
//
// The transcript is shared — other clients and the server write it too, one
// at a time under the session lock — so a turn holding the lock first makes
// its copy the server's (`makeCurrent`). A step left cut by a crash (tool
// calls with no results) is answered then, so the next model call is one the
// provider accepts.
import type { ModelMessage, ToolCallPart } from 'ai';
import type { PhantomBackend } from './backend.js';
import { asPhantomError, type PhantomError } from './errors.js';
import { interruptedResultMessage } from './messages.js';
import { SessionRecord } from './record.js';
import { conversationFrom, cutLastAssistantMessage, messageLine, type TokenTotals, type TranscriptLine } from './transcript.js';
import type { LlmConfig } from './model/llmConfig.js';
import type { StoredSystemPrompt } from './systemPrompt.js';

/** The session row, the fields the runtime and an agent read.
 *  `system_prompt` is the prompt as assembled at create — the three
 *  sections every turn sends; null only on a row born before it existed. */
export interface SessionRow {
  id: string;
  workspaceId: string;
  folderId: string | null;
  status: string;
  agent: string | null;
  name: string | null;
  planMode: boolean;
  system_prompt: StoredSystemPrompt | null;
}

/** What an app sees of the session. */
export interface SessionInfo {
  readonly id: string;
  readonly workspaceId: string;
  readonly folderId: string | null;
  /** Read-only mode: mutating tools refuse. The row's, kept live from the
   *  session feed while a turn runs. */
  readonly planMode: boolean;
  readonly row: Readonly<SessionRow>;
  /** The conversation as the model sees it. */
  readonly messages: readonly ModelMessage[];
  /** The tokens the record accounts for, whoever wrote them. */
  readonly usage: Readonly<TokenTotals>;
}

/** What starting a turn answers: the hold, the record's last-changed mark
 *  (so the turn knows whether its copy is current without downloading
 *  anything), plan mode as the row has it now, and what the turn runs on. */
export interface TurnStart {
  transcript_updated_at: string | null;
  planMode: boolean;
  config: LlmConfig;
  tools: PublishedTool[];
}
export interface PublishedTool { name: string; summary: string; description?: string; input: Record<string, unknown>; mutates: boolean }

export class Session implements SessionInfo {
  #row: SessionRow;
  #messages: ModelMessage[];

  private constructor(private readonly backend: PhantomBackend, private readonly handlers: { onError(e: PhantomError): void },
    row: SessionRow, private readonly record: SessionRecord) {
    this.#row = row;
    this.#messages = conversationFrom(record.lines);
  }

  /** The row as it stands, then the record. Loading only reads. `handlers`
   *  hears the one failure that must not throw over another: a lock release. */
  static async load(backend: PhantomBackend, handlers: { onError(e: PhantomError): void }, sessionId: string): Promise<Session> {
    const row = await backend.call<SessionRow>('GET', `/sessions/${sessionId}`);
    return new Session(backend, handlers, row, await SessionRecord.load(backend, sessionId));
  }

  get id(): string { return this.#row.id; }
  get workspaceId(): string { return this.#row.workspaceId; }
  get folderId(): string | null { return this.#row.folderId; }
  get planMode(): boolean { return this.#row.planMode; }
  get row(): Readonly<SessionRow> { return this.#row; }
  get messages(): readonly ModelMessage[] { return this.#messages; }
  get usage(): Readonly<TokenTotals> { return this.record.usage; }

  /** Plan mode as the server says it: turn-start's answer, or the session
   *  feed mid-turn. */
  setPlanMode(on: boolean): void { this.#row = { ...this.#row, planMode: on }; }

  /** One turn on this session: start it (the hold, the server's queued
   *  messages written, the model and tools answered — one request), run
   *  `fn`, end it (the server's bookkeeping and the release — one request,
   *  always, so a turn that threw still lets go). The server renews the hold
   *  on the turn's own writes. An end that fails is reported, never thrown
   *  over the turn's own outcome. */
  async turn<T>(type: string, signal: AbortSignal, fn: (start: TurnStart & { recordMoved: boolean }) => Promise<T>): Promise<T> {
    const start = await this.backend.call<TurnStart>('POST', `/sessions/${this.id}/turn-start`,
      { type, label: this.backend.label }, { signal });
    try {
      return await fn({ ...start, recordMoved: start.transcript_updated_at !== this.record.stamp });
    } finally {
      try { await this.backend.call('POST', `/sessions/${this.id}/turn-ended`); }
      catch (e) { this.handlers.onError(asPhantomError(e, 'internal', 'ending the turn')); }
    }
  }

  /** Under the lock: make this copy the server's — read what others added,
   *  answer a step a crash left cut. Resolves true when the copy changed. */
  async makeCurrent(recordMoved: boolean, signal: AbortSignal): Promise<boolean> {
    if (recordMoved) {
      await this.record.catchUp(signal);
      this.#messages = conversationFrom(this.record.lines);
    }
    const cut = danglingCalls(this.#messages);
    if (cut.length) await this.append(cut.map((c) => messageLine(interruptedResultMessage(c))));
    return recordMoved;
  }

  /** Append to the record; the conversation grows with it. Answers the
   *  messages added. Rejects → the turn fails. */
  async append(lines: TranscriptLine[]): Promise<ModelMessage[]> {
    await this.record.append(lines);
    const added: ModelMessage[] = [];
    for (const l of lines) {
      if (l.type === 'message') { this.#messages.push(l.message); added.push(l.message); }
      else if (l.type === 'partial_message') cutLastAssistantMessage(this.#messages, l.text);
    }
    return added;
  }

  /** The person received the last reply only up to `text`: the conversation
   *  held here is cut now; the record line follows under the next hold. */
  cutLastReply(text: string): void { cutLastAssistantMessage(this.#messages, text); }
}

/** The tool calls of the last assistant message that never got a result —
 *  what a step cut by a crash leaves behind. Results may follow the call as
 *  separate tool messages (one per landed result), so the walk is: back to
 *  the last assistant message, collecting what was answered after it. */
function danglingCalls(messages: readonly ModelMessage[]): ToolCallPart[] {
  const answered = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'tool') {
      for (const p of m.content) if (p.type === 'tool-result') answered.add(p.toolCallId);
      continue;
    }
    if (m.role !== 'assistant' || typeof m.content === 'string') return [];
    return m.content.filter((p): p is ToolCallPart => p.type === 'tool-call' && !answered.has(p.toolCallId));
  }
  return [];
}
