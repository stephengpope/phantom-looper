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
import { conversationFrom, messageLine, type TokenTotals, type TranscriptLine } from './transcript.js';

/** The session row as the server answers it. The fields the runtime reads
 *  are declared; `system_prompt` is whatever the app stores there, read by
 *  its own agent; anything else the server adds rides along. */
export interface SessionRow {
  id: string;
  workspaceId: string;
  folderId: string | null;
  status: string;
  agent?: string | null;
  name?: string | null;
  planMode?: boolean;
  system_prompt?: unknown;
  [k: string]: unknown;
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

/** What taking the lock answers: the record's last-changed mark rides along,
 *  so a turn knows whether its copy is current without downloading anything. */
interface LockReply { transcript_updated_at?: string | null }

export class Session implements SessionInfo {
  #row: SessionRow;
  #messages: ModelMessage[];

  private constructor(private readonly backend: PhantomBackend, row: SessionRow, private readonly record: SessionRecord) {
    this.#row = row;
    this.#messages = conversationFrom(record.lines);
  }

  /** The row as it stands, then the record. Opening only reads. */
  static async open(backend: PhantomBackend, sessionId: string): Promise<Session> {
    const row = await backend.call<SessionRow>('GET', `/sessions/${sessionId}`);
    return new Session(backend, row, await SessionRecord.load(backend, sessionId));
  }

  get id(): string { return this.#row.id; }
  get workspaceId(): string { return this.#row.workspaceId; }
  get folderId(): string | null { return this.#row.folderId; }
  get planMode(): boolean { return this.#row.planMode === true; }
  get row(): Readonly<SessionRow> { return this.#row; }
  get messages(): readonly ModelMessage[] { return this.#messages; }
  get usage(): Readonly<TokenTotals> { return this.record.usage; }

  /** The row as the server has it now (plan mode, the folder the tools open). */
  async refresh(signal?: AbortSignal): Promise<void> {
    this.#row = await this.backend.call<SessionRow>('GET', `/sessions/${this.id}`, undefined, { signal });
  }

  /** The session feed said the row moved. */
  rowMoved(patch: Partial<SessionRow>): void { this.#row = { ...this.#row, ...patch }; }

  /** Hold the session for `fn`. The server renews the hold on the turn's
   *  own writes. The release runs even when fn threw; a release that fails
   *  is reported, never thrown over the real error. */
  async withLock<T>(signal: AbortSignal, onReleaseFailed: (e: PhantomError) => void,
    fn: (lock: { recordMoved: boolean }) => Promise<T>): Promise<T> {
    const lock = await this.backend.call<LockReply>('POST', `/sessions/${this.id}/lock`,
      { label: this.backend.label }, { signal });
    try {
      return await fn({ recordMoved: (lock?.transcript_updated_at ?? null) !== this.record.stamp });
    } finally {
      try { await this.backend.call('DELETE', `/sessions/${this.id}/lock`); }
      catch (e) { onReleaseFailed(asPhantomError(e, 'backend_error', 'releasing the session lock')); }
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

  /** The one-line notes the server holds for this session's next turn (a
   *  detached command exited, a sync pulled). Taken, not read. */
  async takeNotes(signal: AbortSignal): Promise<string[]> {
    const r = await this.backend.call<{ messages: string[] }>('POST', `/sessions/${this.id}/backdoor/drain`, undefined, { signal });
    return r.messages;
  }

  /** Append to the record; the conversation grows with it. Answers the
   *  messages added. Rejects → the turn fails. */
  async append(lines: TranscriptLine[]): Promise<ModelMessage[]> {
    await this.record.append(lines);
    const added = conversationFrom(lines);
    this.#messages.push(...added);
    return added;
  }

  /** A turn ended here: the server's bookkeeping (turn count, seat, name). */
  turnEnded(): Promise<unknown> {
    return this.backend.call('POST', `/sessions/${this.id}/turn-ended`);
  }
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
