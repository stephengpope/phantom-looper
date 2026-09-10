// The one transcript format, for every agent. A transcript is a JSONL file:
// line 1 is the header — which agent, what model, the FROZEN system prompt,
// when it began — and every line after it is one ModelMessage exactly as it
// went to the model.
//
// Appended the moment a message exists — the user message on submit, each
// step's messages when that step ends — never batched to the end of a turn,
// so a kill costs at most the step in flight (an interrupt costs nothing:
// runTurn writes the cut step from the stream, then `{type:'interrupted'}`;
// its tools already ran, so the record must say so). JSONL, not one
// rewritten .json: appending is the whole point, and a torn write costs one
// line. Loading skips lines that do not parse, which is what makes that true
// (pi's rule, session-manager.ts).
//
// Who writes one: the TUI's coding sessions (~/.phantom-cli/sessions/<id>.jsonl,
// resumed from), the Assistant (~/.phantom-cli/voice/, one per engine
// start), and the server's one-shot helpers (work/<session>/logs/ —
// outside repo/ so auto-push never commits it).
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ModelMessage } from 'ai';

/** Line 1. Written once; resume reads the messages and ignores the rest —
 *  provider/model record what wrote the transcript, not what will replay it.
 *  Extra fields are welcome (the coding header carries session/workspace/
 *  branch). */
export interface TranscriptHeader {
  type: 'session';
  /** Which agent wrote this ('coding' | 'assistant' | 'supervisor'). Absent on
   *  coding transcripts from before the field existed. */
  agent?: string;
  provider: string;
  model: string;
  created_at: string;
  /** The frozen system prompt (see agents/coding.ts). Absent on old files. */
  system_prompt?: string;
  [extra: string]: unknown;
}

export class Transcript {
  private started: boolean;

  constructor(private header: TranscriptHeader, readonly path: string) {
    this.started = existsSync(this.path);
  }

  /** Append one message. Synchronous by design: the write must land before the
   *  next one is produced, and these are a few hundred bytes. */
  append(message: ModelMessage): void {
    if (!this.started) {
      // Created on first write, so a run nobody spoke to leaves no file.
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, `${JSON.stringify(this.header)}\n`);
      this.started = true;
    }
    appendFileSync(this.path, `${JSON.stringify(message)}\n`);
  }

  appendAll(messages: ModelMessage[]): void {
    for (const m of messages) this.append(m);
  }

  /** One agent step, whole: its messages and its usage line. THE per-step
   *  write — every file-backed agent (the cli's coding sessions, the
   *  Assistant, the supervisor) records a step through this one method, so
   *  usage tracking is the turn machinery's, never re-implemented per agent. */
  appendStep(messages: ModelMessage[], usage?: Parameters<typeof usageEvent>[0]): void {
    this.appendAll(messages);
    this.appendEvent(usageEvent(usage));
  }

  /** A non-message marker (a model switch, say). loadTranscript keeps only the
   *  header and anything with a `role`, so these are invisible to replay and
   *  safe to add without a format version. */
  appendEvent(event: Record<string, unknown> & { type: string }): void {
    this.append(event as never);
  }

  /** Re-point the header's model fields. Only meaningful while the session is
   *  UNPINNED (nothing said yet — a fresh session, or a duplicate's copy):
   *  until the first turn saves, the header's provider/model/base_url are
   *  provisional and follow /model and presets; the first save pins whatever
   *  the header then names. Line 1 on disk and this header move together;
   *  the file's other header fields (the frozen prompt, created_at) are kept. */
  setModel(model: { provider: string; model: string; base_url?: string | null }): void {
    const patch = { provider: model.provider, model: model.model,
      ...(model.base_url ? { base_url: model.base_url } : { base_url: undefined }) };
    this.header = { ...this.header, ...patch };
    if (!this.started) return;   // nothing on disk yet — the first append writes it
    const text = readFileSync(this.path, 'utf8');
    const nl = text.indexOf('\n');
    const first = nl < 0 ? text : text.slice(0, nl);
    try {
      const h = JSON.parse(first) as { type?: string };
      if (h.type !== 'session') return;
      const line = JSON.stringify({ ...h, ...patch });
      writeFileSync(this.path, nl < 0 ? line : line + text.slice(nl), { mode: 0o600 });
    } catch { /* an unparsable first line is left alone — the loader skips it too */ }
  }
}

/** A non-message line and where it sits: `at` = how many messages precede it,
 *  so a rebuild (serializeTranscript) puts it back between the same two
 *  messages it was appended between. */
export interface TranscriptEvent {
  at: number;
  event: Record<string, unknown> & { type: string };
}

/** A whole conversation as JSONL text — header line first — the inverse of
 *  parseTranscript. What a memory-backed caller (the looper, the turn route)
 *  PUTs as the record. `events` (usage marks and the like) are re-interleaved
 *  at their `at` positions, so a rebuild from parsed messages does not lose
 *  them. */
export function serializeTranscript(
  header: TranscriptHeader, messages: ModelMessage[], events: TranscriptEvent[] = [],
): string {
  const lines: string[] = [JSON.stringify(header)];
  const sorted = [...events].sort((a, b) => a.at - b.at);
  let ei = 0;
  for (let i = 0; i <= messages.length; i++) {
    while (ei < sorted.length && sorted[ei].at <= i) lines.push(JSON.stringify(sorted[ei++].event));
    if (i < messages.length) lines.push(JSON.stringify(messages[i]));
  }
  return lines.join('\n') + '\n';
}

export interface LoadedTranscript {
  header?: TranscriptHeader;
  messages: ModelMessage[];
  /** Non-message lines that survived the parse, in file order, each pinned to
   *  its position in `messages`. A memory-backed caller carries these back
   *  into serializeTranscript so rebuilding the record keeps them. */
  events: TranscriptEvent[];
}

/** Parse a transcript from its raw JSONL text — the server row and the local
 *  file share this one reading. Unparsable lines are skipped: the last line of
 *  a run that died mid-append is the expected damage, and it must not cost the
 *  session. */
export function parseTranscript(text: string): LoadedTranscript {
  const out: LoadedTranscript = { messages: [], events: [] };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); } catch { continue; }
    const e = entry as { type?: string; role?: string };
    if (e.type === 'session') out.header = entry as TranscriptHeader;
    else if (e.role) out.messages.push(entry as ModelMessage);
    else if (e.type) out.events.push({ at: out.messages.length, event: entry as TranscriptEvent['event'] });
  }
  out.messages = dropDanglingToolCall(out.messages);
  // Events that sat after a trimmed dangling tool call describe cut content.
  out.events = out.events.filter((ev) => ev.at <= out.messages.length);
  return out;
}

/** Read a transcript back from disk. Missing file returns no messages. */
export function loadTranscriptFile(file: string): LoadedTranscript {
  if (!existsSync(file)) return { messages: [], events: [] };
  return parseTranscript(readFileSync(file, 'utf8'));
}

/** A transcript file's name stamp — sorts lexicographically in time order. */
export function transcriptStamp(now = new Date()): string {
  return now.toISOString().replace(/[:.]/g, '-');
}

/** The newest `.jsonl` in a transcript directory — the live one a resume
 *  loads; older files are the archive compaction left behind. Null when the
 *  directory is missing or holds none. */
export function newestTranscriptFile(dir: string): string | null {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    return files.length ? join(dir, files[files.length - 1]) : null;
  } catch { return null; }
}

/** The last thing the user said in a JSONL transcript — the resume list's
 *  one-line description of a conversation. Takes the raw text so the server (a
 *  DB column, extracted at save) and the TUI (a local file) share one reading. */
export function lastUserFromJsonl(text: string): string | undefined {
  let last: string | undefined;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: { role?: string; content?: unknown };
    try { e = JSON.parse(line); } catch { continue; }
    if (e.role !== 'user') continue;
    const t = typeof e.content === 'string'
      ? e.content
      : Array.isArray(e.content)
        ? e.content.filter((c: { type?: string }) => c?.type === 'text')
            .map((c: { text?: string }) => c.text ?? '').join('')
        : '';
    if (t.trim()) last = t.trim().replace(/\s+/g, ' ');
  }
  return last;
}

/** The model a JSONL transcript's header line names — provider, model and the
 *  endpoint it was called at, the three fields that only mean anything
 *  together. Returns nulls when the first line is not a session header or
 *  cannot be parsed — callers leave the columns unchanged. Cheap: reads only to
 *  the first newline. */
export function headerModelFromJsonl(text: string):
{ provider: string | null; model: string | null; baseUrl: string | null } {
  const none = { provider: null, model: null, baseUrl: null };
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  try {
    const h = JSON.parse(first) as { type?: string; provider?: string; model?: string; base_url?: string };
    if (h.type !== 'session') return none;
    return {
      provider: typeof h.provider === 'string' ? h.provider : null,
      model: typeof h.model === 'string' ? h.model : null,
      baseUrl: typeof h.base_url === 'string' ? h.base_url : null,
    };
  } catch { return none; }
}

// --- token usage -------------------------------------------------------------
// One `{"type":"usage",...}` line per model call, appended right after the
// call's messages. No role, so replay never sees it (parseTranscript keeps it
// in `events`). The transcript save sums these lines into the sessions row in
// the same statement as the text — the transcript is the record, the row its
// cache, and the two cannot disagree.

export interface UsageTotals {
  input: number;        // input (prompt) tokens as the provider reported them
  output: number;       // output (completion) tokens
  cache_read: number;   // input tokens served from the provider's prompt cache
  cache_write: number;  // input tokens written into the cache
}

/** The AI SDK's normalized usage → one usage event. Providers leave fields
 *  undefined when they do not report them; those count as 0. */
export function usageEvent(u?: {
  inputTokens?: number; outputTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
}): Record<string, unknown> & { type: 'usage' } {
  return {
    type: 'usage',
    input: u?.inputTokens ?? 0,
    output: u?.outputTokens ?? 0,
    cache_read: u?.inputTokenDetails?.cacheReadTokens ?? 0,
    cache_write: u?.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

/** What createAgent's `record` option writes through: one step, messages +
 *  usage. `Transcript` satisfies this (file-backed agents hand their
 *  transcript over); memoryRecorder builds one for the serialize-at-turn-end
 *  callers. */
export interface StepRecord {
  appendStep(messages: ModelMessage[], usage?: Parameters<typeof usageEvent>[0]): void;
  /** A non-message marker (Transcript has one; memory recorders need none).
   *  runTurn writes `{type:'interrupted'}` after a step it recorded because
   *  esc cut it before the SDK could. */
  appendEvent?(event: Record<string, unknown> & { type: string }): void;
}

/** A StepRecord for memory-backed turn runners (the looper's rounds, the
 *  server turn route): collects each step's MESSAGES and its usage line at
 *  its position for the turn-end serializeTranscript rebuild. The messages
 *  collect here because the step seam is the only complete record — the
 *  SDK's turn-end `response.messages` carries only the FINAL step, so a
 *  save built from it loses every tool call and result before it (found
 *  live: the coder's block turn saved as its closing text alone). `startAt`
 *  = how many messages the conversation holds before this turn's first
 *  step lands. */
export function memoryRecorder(startAt: number):
{ record: StepRecord; events: TranscriptEvent[]; messages: ModelMessage[] } {
  let at = startAt;
  const events: TranscriptEvent[] = [];
  const messages: ModelMessage[] = [];
  return {
    events,
    messages,
    record: {
      appendStep: (stepMessages, usage) => {
        messages.push(...stepMessages);
        at += stepMessages.length;
        events.push({ at, event: usageEvent(usage) });
      },
    },
  };
}

/** A transcript without its usage lines — what a duplicate seats: the copy's
 *  token totals are its own spend from birth, and the row's cache is summed
 *  from this text, so the lines must not travel. Same line-tolerant reading
 *  as sumUsageFromJsonl: anything unparsable is kept. */
export function stripUsageFromJsonl(text: string): string {
  return text.split('\n').filter((line) => {
    if (!line.includes('"usage"')) return true;
    try { return (JSON.parse(line) as { type?: string }).type !== 'usage'; }
    catch { return true; }
  }).join('\n');
}

/** Sum every usage line in a transcript's raw JSONL — the on-demand totals
 *  the API serves. Same line-tolerant reading as everything else here. */
export function sumUsageFromJsonl(text: string): UsageTotals {
  const t: UsageTotals = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  for (const line of text.split('\n')) {
    // Cheap gate before the parse: a transcript is mostly fat message lines
    // (~17MB observed), and every usage line literally contains "usage", so a
    // substring scan skips them without building an object per line. A rare
    // false positive (a tool result mentioning usage) parses and falls through.
    if (!line.includes('"usage"')) continue;
    let e: { type?: string; input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown };
    try { e = JSON.parse(line); } catch { continue; }
    if (e.type !== 'usage') continue;
    for (const k of ['input', 'output', 'cache_read', 'cache_write'] as const) {
      const n = e[k];
      if (typeof n === 'number' && Number.isFinite(n)) t[k] += n;
    }
  }
  return t;
}

/** Every tool call needs its result or the next request is rejected (Anthropic
 *  and OpenAI both refuse a tool_use with no tool_result). Writing a whole step
 *  at once makes that the normal case; a process killed between the two lines
 *  of one step is the exception, so cut the history there instead of failing
 *  the first turn of the resumed session. */
export function dropDanglingToolCall(messages: ModelMessage[]): ModelMessage[] {
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === 'tool') {
      for (const c of m.content) if (c.type === 'tool-result') answered.add(c.toolCallId);
    }
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    const dangling = m.content.some(
      (c) => c.type === 'tool-call' && !answered.has(c.toolCallId));
    if (dangling) return messages.slice(0, i);
  }
  return messages;
}
