// The record's line format — what the server stores, one JSON line per
// entry, every line typed. Pure: no I/O, no client. The server imports this
// file (@phantom-agent-sdk/client/transcript) to read and write the same shape.
//
//   { type:"message",         id, at, message:{ role, content } }
//   { type:"usage",           id, at, provider, model, input, output, cacheRead, cacheWrite }
//   { type:"interrupted",     id, at }
//   { type:"partial_message", id, at, text }   the assistant message before this
//                                              line reached the person only up to
//                                              `text` (a reply cut off while being
//                                              spoken); the reader keeps that much
//   { type:"system_prompt_rebuilt", id, at, sections }   the row's prompt was reassembled
//                                              here, the named sections changed
//
// A `message` line is exactly the AI SDK message that went to (or came from)
// the model. Cache marks (providerOptions) are per-call and are NEVER
// written — `messageLine` refuses a message that carries them. A `usage`
// line names its model when the writer knows it.
import type { ModelMessage } from 'ai';
import { PhantomError } from './errors.js';
import type { SystemPromptSection } from './systemPrompt.js';

export interface TokenTotals { input: number; output: number; cacheRead: number; cacheWrite: number }
/** One model call's usage, as billed. */
export interface TokenUsage extends TokenTotals { provider: string; model: string; responseId?: string }

export interface MessageLine { type: 'message'; id: string; at: string; message: ModelMessage }
export interface UsageLine extends TokenTotals { type: 'usage'; id: string; at: string; provider?: string; model?: string; responseId?: string }
export interface InterruptedLine { type: 'interrupted'; id: string; at: string }
export interface PartialMessageLine { type: 'partial_message'; id: string; at: string; text: string }
/** The session's system prompt was reassembled here — the named sections
 *  changed on the row; the model's next call ran on them (Agent.sendMessage's
 *  rebuildSystemPrompt). */
export interface SystemPromptRebuiltLine { type: 'system_prompt_rebuilt'; id: string; at: string; sections: SystemPromptSection[] }
export type TranscriptLine = MessageLine | UsageLine | InterruptedLine | PartialMessageLine | SystemPromptRebuiltLine;

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
export const usageLine = (usage: TokenUsage): UsageLine => ({ type: 'usage', id: lineId(), at: now(), ...usage });
export const interruptedLine = (): InterruptedLine => ({ type: 'interrupted', id: lineId(), at: now() });
export const partialMessageLine = (text: string): PartialMessageLine => ({ type: 'partial_message', id: lineId(), at: now(), text });
export const systemPromptRebuiltLine = (sections: SystemPromptSection[]): SystemPromptRebuiltLine => ({ type: 'system_prompt_rebuilt', id: lineId(), at: now(), sections });
export const userMessage = (content: string): ModelMessage => ({ role: 'user', content });
export const assistantMessage = (content: string): ModelMessage => ({ role: 'assistant', content });

/** The last assistant message with its text replaced by what the person
 *  actually received (tool calls and anything else kept): the model must
 *  remember what was heard, not what it was going to say. No assistant
 *  message = nothing to cut. In place. */
export function cutLastAssistantMessage(messages: ModelMessage[], text: string): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role !== 'assistant') continue;
    if (typeof message.content === 'string') { messages[i] = { ...message, content: text }; return; }
    const rest = message.content.filter((part) => part.type !== 'text');
    const at = message.content.findIndex((part) => part.type === 'text');
    const part = { type: 'text' as const, text };
    messages[i] = { ...message, content: at < 0 ? [part, ...rest] : [...rest.slice(0, at), part, ...rest.slice(at)] };
    return;
  }
}

/** What the model sees: every message line, in order, each partial_message
 *  line applied to the assistant message before it. */
export function conversationFrom(lines: readonly TranscriptLine[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const line of lines) {
    if (line.type === 'message') out.push(line.message);
    else if (line.type === 'partial_message') cutLastAssistantMessage(out, line.text);
  }
  return out;
}

/** The tokens the lines account for. */
export function usageTotals(lines: readonly TranscriptLine[]): TokenTotals {
  const totals: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const line of lines) {
    if (line.type !== 'usage') continue;
    totals.input += line.input; totals.output += line.output; totals.cacheRead += line.cacheRead; totals.cacheWrite += line.cacheWrite;
  }
  return totals;
}

export const addTotals = (a: TokenTotals, b: TokenTotals): TokenTotals =>
  ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });

const LINE_TYPES = new Set(['message', 'usage', 'interrupted', 'partial_message', 'system_prompt_rebuilt']);

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

/** The last user message in a record, as one line — what a session list
 *  shows under the title. undefined when no user has spoken. */
export function lastUserMessageText(text: string): string | undefined {
  let last: string | undefined;
  for (const line of parseLines(text)) {
    if (line.type !== 'message') continue;
    const message = line.message;
    if (message.role !== 'user') continue;
    const content = typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    if (content.trim()) last = content.trim().replace(/\s+/g, ' ');
  }
  return last;
}

/** The record without its usage lines — what a duplicate copies: the
 *  conversation, not the spend. */
export function withoutUsageLines(text: string): string {
  return text.split('\n').filter((line) => {
    if (!line.includes('"usage"')) return true;
    try { return (JSON.parse(line) as { type?: string }).type !== 'usage'; }
    catch { return true; }
  }).join('\n');
}
