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
// written — `messageLine` refuses a message that carries them. A `usage`
// line names its model when the writer knows it.
import type { ModelMessage } from 'ai';
import { PhantomError } from './errors.js';

export interface TokenTotals { input: number; output: number; cacheRead: number; cacheWrite: number }
/** One model call's usage, as billed. */
export interface TokenUsage extends TokenTotals { provider: string; model: string; responseId?: string }

export interface MessageLine { type: 'message'; id: string; at: string; message: ModelMessage }
export interface UsageLine extends TokenTotals { type: 'usage'; id: string; at: string; provider?: string; model?: string; responseId?: string }
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

const LINE_TYPES = new Set(['message', 'usage', 'interrupted']);

/** Parse the server's text: one JSON per line. A line that does not parse
 *  is a torn write and is skipped; a line that is not one of ours is
 *  skipped too. */
export function parseLines(text: string): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    let j: unknown;
    try { j = JSON.parse(raw); } catch { continue; }
    if (j && typeof j === 'object' && LINE_TYPES.has((j as { type?: string }).type ?? '')) out.push(j as TranscriptLine);
  }
  return out;
}
