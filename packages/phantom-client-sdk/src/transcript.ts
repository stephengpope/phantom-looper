// The record's line format — what the server stores, one JSON line per
// entry, every line typed. Pure: no I/O, no client. The server imports this
// file (phantom-client-sdk/transcript) to read and write the same shape.
//
//   { type:"message",     id, at, message:{ role, content } }
//   { type:"usage",       id, at, provider, model, input, output, cacheRead, cacheWrite }
//   { type:"interrupted", id, at }
//
// A `message` line is exactly the AI SDK message that went to (or came from)
// the model. Cache marks (providerOptions) are per-call and are NEVER
// written — `messageLine` refuses a message that carries them.
//
// Reading also accepts the shape records were written in before this
// format: a bare message `{ role, content }` and a usage line with
// `cache_read`/`cache_write`. Nothing writes that shape any more; every
// existing session was recorded in it.
import type { ModelMessage } from 'ai';
import { PhantomError } from './errors.js';

export interface TokenUsage {
  provider: string; model: string; responseId?: string;
  input: number; output: number; cacheRead: number; cacheWrite: number;
}
export interface TokenTotals { input: number; output: number; cacheRead: number; cacheWrite: number }

export interface MessageLine { type: 'message'; id: string; at: string; message: ModelMessage }
export interface UsageLine extends TokenUsage { type: 'usage'; id: string; at: string }
export interface InterruptedLine { type: 'interrupted'; id: string; at: string }
export type TranscriptLine = MessageLine | UsageLine | InterruptedLine;

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
export const userMessage = (content: string): ModelMessage => ({ role: 'user', content });

/** What the model sees: every message line, in order. */
export const conversationFrom = (lines: readonly TranscriptLine[]): ModelMessage[] =>
  lines.flatMap((l) => (l.type === 'message' ? [l.message] : []));

/** The tokens the lines account for. */
export function usageTotals(lines: readonly TranscriptLine[]): TokenTotals {
  const t: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const l of lines) {
    if (l.type !== 'usage') continue;
    t.input += l.input; t.output += l.output; t.cacheRead += l.cacheRead; t.cacheWrite += l.cacheWrite;
  }
  return t;
}

export const addTotals = (a: TokenTotals, b: TokenTotals): TokenTotals =>
  ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** One parsed line in either shape, or null for a line that is not ours. */
function lineFrom(j: Record<string, unknown>): TranscriptLine | null {
  const id = typeof j.id === 'string' ? j.id : lineId();
  const at = typeof j.at === 'string' ? j.at : '';
  switch (j.type) {
    case 'message': return j as unknown as MessageLine;
    case 'interrupted': return { type: 'interrupted', id, at };
    case 'usage':
      return { type: 'usage', id, at,
        provider: typeof j.provider === 'string' ? j.provider : '', model: typeof j.model === 'string' ? j.model : '',
        ...(typeof j.responseId === 'string' ? { responseId: j.responseId } : {}),
        input: n(j.input), output: n(j.output),
        cacheRead: n(j.cacheRead ?? j.cache_read), cacheWrite: n(j.cacheWrite ?? j.cache_write) };
    case undefined:
      // The earlier format: the message itself, no envelope.
      if (typeof j.role === 'string' && 'content' in j) return { type: 'message', id, at, message: j as unknown as ModelMessage };
      return null;
    default: return null;
  }
}

/** Parse the server's text: one JSON per line. A line that does not parse
 *  is a torn write and is skipped; a line that is not one of ours is
 *  skipped too. */
export function parseLines(text: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let j: unknown;
    try { j = JSON.parse(raw); } catch { continue; }
    if (!j || typeof j !== 'object') continue;
    const line = lineFrom(j as Record<string, unknown>);
    if (line) out.push(line);
  }
  return out;
}
