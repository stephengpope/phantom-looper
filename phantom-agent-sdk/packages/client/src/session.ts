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
import type { BackendClient } from './backend.js';
import { asPhantomError, type PhantomError } from './errors.js';
import { interruptedResultMessage } from './messages.js';
import { SessionRecord } from './record.js';
import { conversationFrom, cutLastAssistantMessage, messageLine, type TokenTotals, type TranscriptLine } from './transcript.js';
import type { LlmConfig } from './model/llmConfig.js';
import type { StoredSystemPrompt, SystemPromptLayout } from './systemPrompt.js';

/** The session row, the fields the runtime and an agent read.
 *  `system_prompt` is the prompt as assembled at create — the three
 *  sections every turn sends; null only on a row born before it existed. */
export interface SessionRow {
  id: string;
  projectId: string;
  workspaceId: string | null;
  status: string;
  agent: string | null;
  name: string | null;
  planMode: boolean;
  system_prompt: StoredSystemPrompt | null;
}

/** What an app sees of the session. */
export interface SessionInfo {
  readonly id: string;
  readonly projectId: string;
  readonly workspaceId: string | null;
  /** Read-only mode: mutating tools refuse. The row's, kept live from the
   *  session feed while a turn runs. */
  readonly planMode: boolean;
  readonly row: Readonly<SessionRow>;
  /** The conversation as the model sees it. */
  readonly messages: readonly ModelMessage[];
  /** The tokens the record accounts for, whoever wrote them. */
  readonly usage: Readonly<TokenTotals>;
  /** The server's last-changed mark for the record copy held here — what
   *  `GET /sessions/:id` answers as transcript_updated_at when the copy is
   *  current. Moves with every line this agent writes and every catch-up. */
  readonly transcriptUpdatedAt: string | null;
}

/** What starting a turn answers: the hold, the record's last-changed mark
 *  (so the turn knows whether its copy is current without downloading
 *  anything), plan mode as the row has it now, and what the turn runs on. */
export interface TurnStart {
  transcript_updated_at: string | null;
  planMode: boolean;
  config: LlmConfig;
  tools: PublishedTool[];
  /** The row's prompt after a rebuild — present only when the turn asked for one. */
  system_prompt?: StoredSystemPrompt;
}
export interface PublishedTool { name: string; summary: string; description?: string; input: Record<string, unknown>; mutates: boolean }

export class Session implements SessionInfo {
  #row: SessionRow;
  #messages: ModelMessage[];
  /** The last turn's end on its way to the server (its feed closing, then
   *  turn-ended, which lets go of the hold). The next turn starts after it,
   *  so a release can never land on a hold a later turn took. */
  #ending: Promise<void> = Promise.resolve();

  private constructor(private readonly backend: BackendClient, private readonly handlers: { onError(error: PhantomError): void },
    row: SessionRow, private readonly record: SessionRecord) {
    this.#row = row;
    this.#messages = conversationFrom(record.lines);
  }

  /** The row as it stands, then the record. Loading only reads. `handlers`
   *  hears the one failure that must not throw over another: a lock release. */
  static async load(backend: BackendClient, handlers: { onError(error: PhantomError): void }, sessionId: string): Promise<Session> {
    const row = await backend.call<SessionRow>('GET', `/sessions/${sessionId}`);
    return new Session(backend, handlers, row, await SessionRecord.load(backend, sessionId));
  }

  get id(): string { return this.#row.id; }
  get projectId(): string { return this.#row.projectId; }
  get workspaceId(): string | null { return this.#row.workspaceId; }
  get planMode(): boolean { return this.#row.planMode; }
  get row(): Readonly<SessionRow> { return this.#row; }
  get messages(): readonly ModelMessage[] { return this.#messages; }
  get usage(): Readonly<TokenTotals> { return this.record.usage; }
  get transcriptUpdatedAt(): string | null { return this.record.stamp; }

  /** Plan mode as the server says it: turn-start's answer, or the session
   *  feed mid-turn. */
  setPlanMode(on: boolean): void { this.#row = { ...this.#row, planMode: on }; }

  /** One turn on this session: start it (the hold, the session's notes
   *  written, the model and tools answered — one request), run `body`, end
   *  it (the server's bookkeeping and the release — one request, always, so
   *  a turn that threw still lets go). The turn's result is the caller's the
   *  moment `body` returns; the end goes on in the background, after
   *  whatever `body` handed to `endAfter` (the feed closing), and the next
   *  turn waits for it (`ended`). The server renews the hold on the turn's
   *  own writes. An end that fails is reported, never thrown over the
   *  turn's own outcome. */
  async turn<T>(type: string, signal: AbortSignal, body: (start: TurnStart & { recordMoved: boolean; endAfter: (work: Promise<unknown>) => void }) => Promise<T>,
    opts: { rebuildSystemPrompt?: SystemPromptLayout } = {}): Promise<T> {
    await this.#ending;
    const start = await this.backend.call<TurnStart>('POST', `/sessions/${this.id}/turn-start`,
      { type, label: this.backend.label, ...(opts.rebuildSystemPrompt ? { system_prompt_layout: opts.rebuildSystemPrompt } : {}) }, { signal });
    // A rebuilt prompt is the row's now; the record line that marks it is
    // among what makeCurrent reads (the stamp moved).
    if (start.system_prompt) this.#row = { ...this.#row, system_prompt: start.system_prompt };
    let before: Promise<unknown> = Promise.resolve();
    try {
      return await body({ ...start, recordMoved: start.transcript_updated_at !== this.record.stamp,
        endAfter: (work) => { before = work; } });
    } finally {
      this.#ending = before.then(() => undefined, () => undefined)
        .then(() => this.backend.call('POST', `/sessions/${this.id}/turn-ended`))
        .then(() => undefined, (error: unknown) => this.handlers.onError(asPhantomError(error, 'internal', 'ending the turn')));
    }
  }

  /** The last turn's end has reached the server (or failed, reported). */
  ended(): Promise<void> { return this.#ending; }

  /** Under the lock: make this copy the server's — read what others added,
   *  answer a step a crash left cut. Answers what the CONVERSATION gained,
   *  or null when it gained nothing — a record that moved by bookkeeping
   *  alone (the server's system_prompt_rebuilt mark, a usage line) is not a
   *  conversation that moved forward elsewhere, and a host must not repaint
   *  over it. `from` is the stamp this copy stood at before; `added` the
   *  messages appended since, or null when the gain is not plain appends
   *  (a partial_message cut the tail) and the host must redraw whole. */
  async makeCurrent(recordMoved: boolean, signal: AbortSignal): Promise<{ from: string | null; added: ModelMessage[] | null } | null> {
    let gained: { from: string | null; added: ModelMessage[] | null } | null = null;
    if (recordMoved) {
      const from = this.record.stamp;
      const more = await this.record.catchUp(signal);
      this.#messages = conversationFrom(this.record.lines);
      if (more.some((line) => line.type === 'partial_message')) gained = { from, added: null };
      else {
        const added = more.flatMap((line) => (line.type === 'message' ? [line.message] : []));
        if (added.length) gained = { from, added };
      }
    }
    const cut = danglingCalls(this.#messages);
    if (cut.length) await this.append(cut.map((call) => messageLine(interruptedResultMessage(call))));
    return gained;
  }

  /** Append to the record; the conversation grows with it. Answers the
   *  messages added. Rejects → the turn fails. */
  async append(lines: TranscriptLine[]): Promise<ModelMessage[]> {
    await this.record.append(lines);
    const added: ModelMessage[] = [];
    for (const line of lines) {
      if (line.type === 'message') { this.#messages.push(line.message); added.push(line.message); }
      else if (line.type === 'partial_message') cutLastAssistantMessage(this.#messages, line.text);
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
    const message = messages[i]!;
    if (message.role === 'tool') {
      for (const part of message.content) if (part.type === 'tool-result') answered.add(part.toolCallId);
      continue;
    }
    if (message.role !== 'assistant' || typeof message.content === 'string') return [];
    return message.content.filter((part): part is ToolCallPart => part.type === 'tool-call' && !answered.has(part.toolCallId));
  }
  return [];
}
