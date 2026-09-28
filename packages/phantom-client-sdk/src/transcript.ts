// The transcript: append-only, one JSON line per entry, every line typed.
//
//   { type:"message",     id, at, message:{ role, content } }
//   { type:"usage",       id, at, provider, model, input, output, cacheRead, cacheWrite }
//   { type:"interrupted", id, at }
//   { type:"compaction",  id, at, summary, firstKeptId }
//
// A `message` line is exactly the AI SDK message that went to (or came from)
// the model. Cache marks (providerOptions) are per-call and are NEVER
// written — `append` refuses a message that carries them.
//
// Loading: the last `compaction` line, if any (written by the server when
// it summarizes a long conversation), opens the conversation with its
// summary; then every `message` line after `firstKeptId`. Older lines stay
// as history and are never sent to the model again. Without a compaction
// line, every `message` line.
//
// Writing: POST /sessions/:id/transcript/append { after, deliveryId, lines }.
// The server writes only if it has exactly `after` lines AND has not seen
// `deliveryId`. A lost reply → resend → already seen → no duplicate. A lost
// request → still `after` → written. The client never sends delivery k+1
// before k is answered, so the count it holds always equals the server's.
//
// Others write it too (another window, the server, Telegram — one at a
// time, under the session lock). `stamp` is the server's last-changed mark
// for the copy held here; taking the lock answers the server's current one,
// and a turn that sees them differ reads the lines after its own
// (`catchUp`: GET ...?after=N) before it runs.
import type { ModelMessage } from 'ai';
import { PhantomError } from './errors.js';
import { call, type PhantomBackend } from './backend.js';
import type { TokenUsage } from './model/languageModel.js';

export interface MessageLine { type: 'message'; id: string; at: string; message: ModelMessage }
export interface UsageLine extends TokenUsage { type: 'usage'; id: string; at: string }
export interface InterruptedLine { type: 'interrupted'; id: string; at: string }
export interface CompactionLine { type: 'compaction'; id: string; at: string; summary: string; firstKeptId: string }
export type TranscriptLine = MessageLine | UsageLine | InterruptedLine | CompactionLine;

let seq = 0;
/** Line ids: time-ordered and unique within a process. */
export const lineId = (): string => `${Date.now().toString(36)}-${(++seq).toString(36)}`;
const now = () => new Date().toISOString();

export const messageLine = (message: ModelMessage): MessageLine => {
  if (message.providerOptions) {
    throw new PhantomError('transcript_invalid', 'a message with providerOptions (cache marks) cannot be recorded');
  }
  return { type: 'message', id: lineId(), at: now(), message };
};
export const usageLine = (u: TokenUsage): UsageLine => ({ type: 'usage', id: lineId(), at: now(), ...u });
export const interruptedLine = (): InterruptedLine => ({ type: 'interrupted', id: lineId(), at: now() });
/** What the model sees, rebuilt from the lines. */
export function conversationFrom(lines: readonly TranscriptLine[]): { messages: ModelMessage[] } {
  let last: CompactionLine | null = null;
  for (const l of lines) if (l.type === 'compaction') last = l;
  const messages: ModelMessage[] = [];
  let keeping = last === null;
  if (last) messages.push({ role: 'user', content: last.summary });
  for (const l of lines) {
    if (last && l.id === last.firstKeptId) keeping = true;
    if (!keeping || l.type !== 'message') continue;
    messages.push(l.message);
  }
  return { messages };
}

/** Parse the server's text: one JSON per line. A line that does not parse
 *  is a torn write and is skipped; a line without a known `type` is not ours
 *  and is skipped too. */
export function parseLines(text: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let j: unknown;
    try { j = JSON.parse(raw); } catch { continue; }
    const t = (j as { type?: unknown }).type;
    if (t === 'message' || t === 'usage' || t === 'interrupted' || t === 'compaction') out.push(j as TranscriptLine);
  }
  return out;
}

/** The append client for one session. Sequential by construction: a second
 *  append waits for the first's answer. */
export class Transcript {
  private lineCount: number;
  private lastStamp: string | null;
  private chain: Promise<void> = Promise.resolve();
  readonly lines: TranscriptLine[];

  constructor(private readonly backend: PhantomBackend, readonly sessionId: string,
    lines: TranscriptLine[], lineCount: number, stamp: string | null) {
    this.lines = lines;
    this.lineCount = lineCount;
    this.lastStamp = stamp;
  }

  /** Read the whole record from the server. */
  static async load(backend: PhantomBackend, sessionId: string): Promise<Transcript> {
    const r = await call<{ data: string | null; lines?: number; updated_at?: string | null }>(backend, 'GET', `/sessions/${sessionId}/transcript`);
    const lines = parseLines(r.data ?? '');
    return new Transcript(backend, sessionId, lines, r.lines ?? lines.length, r.updated_at ?? null);
  }

  /** How many lines the server has, as last acknowledged. */
  get count(): number { return this.lineCount; }
  /** The server's last-changed mark for the copy held here. */
  get stamp(): string | null { return this.lastStamp; }

  /** Someone else wrote: read only the lines after ours and add them. */
  async catchUp(): Promise<void> {
    const r = await call<{ data: string | null; lines?: number; updated_at?: string | null }>(this.backend, 'GET',
      `/sessions/${this.sessionId}/transcript?after=${this.lineCount}`);
    const more = parseLines(r.data ?? '');
    this.lines.push(...more);
    this.lineCount = r.lines ?? this.lineCount + more.length;
    this.lastStamp = r.updated_at ?? null;
  }

  /** Append lines. Resolves when the server acknowledged them; rejects with
   *  transcript_conflict (someone else wrote) or transcript_write_failed. */
  append(lines: TranscriptLine[]): Promise<void> {
    if (!lines.length) return this.chain;
    const next = this.chain.then(() => this.send(lines));
    // The chain must survive a failure so a later append can still run
    // (the Agent decides the turn is over); the failure itself is handed to
    // the caller of THIS append through `next`.
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async send(lines: TranscriptLine[]): Promise<void> {
    const after = this.lineCount;
    const deliveryId = lineId();
    let r: { lines: number; applied: boolean; updated_at?: string | null };
    try {
      r = await call<{ lines: number; applied: boolean; updated_at?: string | null }>(this.backend, 'POST',
        `/sessions/${this.sessionId}/transcript/append`, { after, deliveryId, lines });
    } catch (e) {
      if (e instanceof PhantomError && e.code === 'transcript_conflict') throw e;
      throw new PhantomError('transcript_write_failed', `transcript append failed: ${(e as Error).message}`, { cause: e });
    }
    const expected = after + lines.length;
    if (r.lines !== expected) {
      throw new PhantomError('transcript_conflict',
        `transcript has ${r.lines} lines on the server, expected ${expected} — another writer moved it`);
    }
    this.lineCount = r.lines;
    this.lastStamp = r.updated_at ?? null;
    this.lines.push(...lines);
  }
}
