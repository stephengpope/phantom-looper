// Turn state: a pure reducer from AI SDK stream parts to renderable "parts".
//
// The UI never touches the stream directly. `applyPart` folds one
// TextStreamPart into the in-flight turn; `takeCompleted` peels finished
// parts off the front so they can move into Ink's <Static> (rendered once,
// never repainted) while the live region stays a few lines tall. That split
// is the one architectural rule every Ink agent shares (Gemini CLI
// MainContent.tsx, Continue StaticChatContent.tsx, Nanocoder App.tsx) —
// re-rendering the whole transcript per token is what flickers.
//
// A terminal can only rewrite the lines still on screen, so the live region
// must stay well under a viewport; past that Ink stops erasing incrementally
// and repaints the whole transcript every frame (ink.js `shouldClearTerminal`).
// Holding a whole message live until `text-end` is what blew that budget and
// made the message appear to jump on completion. Instead `takeCompleted`
// commits *closed markdown blocks* to <Static> as they stream: a block is
// closed once more input cannot change it (blank line ends a paragraph, ```
// closes a fence), so it can be rendered as markdown and never touched again.
// Only the block being typed right now stays live.
import type { ModelMessage, TextStreamPart, ToolResultPart, ToolSet } from 'ai';

export type Part =
  | { kind: 'note'; id: string; text: string }
  | { kind: 'worked'; id: string; ms: number; at: number }
  | { kind: 'user'; id: string; text: string }
  | { kind: 'text'; id: string; sid?: string; text: string; done: boolean; first?: boolean }
  | { kind: 'reasoning'; id: string; sid?: string; text: string; done: boolean; startedAt: number; endedAt?: number }
  | {
      kind: 'tool'; id: string; name: string;
      inputText: string; input?: unknown;
      status: 'pending' | 'running' | 'ok' | 'error';
      output?: unknown; error?: string;
      startedAt: number; endedAt?: number;
    }
  | { kind: 'error'; id: string; message: string };

export type StreamPart = TextStreamPart<ToolSet>;

let seq = 0;
export const nextId = (prefix: string) => `${prefix}-${++seq}`;

function isDone(p: Part): boolean {
  switch (p.kind) {
    case 'text': case 'reasoning': return p.done;
    case 'tool': return p.status === 'ok' || p.status === 'error';
    default: return true;
  }
}

/** Fold one stream part into the turn. Returns a new array; unknown parts are ignored. */
export function applyPart(turn: Part[], part: StreamPart, now = Date.now()): Part[] {
  // A part's `id` is OURS (nextId — unique for life, it is the React key and
  // two turns must never collide: Anthropic's block ids are the content-block
  // INDEX of one API call, so every reply reuses '0'). The provider's id rides
  // in `sid` and matches deltas to their still-open part; finished parts are
  // skipped — step 2's text arrives with step 1's sid, and matched naively its
  // deltas concatenate onto the finished block above the tool rows. Tool parts
  // keep the toolCallId as `id`: it is globally unique and the result must
  // find its call.
  const bySid = (kind: Part['kind'], sid: string) =>
    turn.findIndex((p) => p.kind === kind && (p as { sid?: string }).sid === sid && !isDone(p));
  const byId = (kind: Part['kind'], id: string) =>
    turn.findIndex((p) => p.kind === kind && p.id === id && !isDone(p));
  const replace = (i: number, p: Part) => [...turn.slice(0, i), p, ...turn.slice(i + 1)];

  switch (part.type) {
    case 'text-start':
      return [...turn, { kind: 'text', id: nextId('text'), sid: part.id, text: '', done: false, first: true }];
    case 'text-delta': {
      const i = bySid('text', part.id);
      if (i < 0) return [...turn, { kind: 'text', id: nextId('text'), sid: part.id, text: part.text, done: false, first: true }];
      const p = turn[i] as Extract<Part, { kind: 'text' }>;
      return replace(i, { ...p, text: p.text + part.text });
    }
    case 'text-end': {
      const i = bySid('text', part.id);
      if (i < 0) return turn;
      const p = turn[i] as Extract<Part, { kind: 'text' }>;
      // Drop empty text blocks (models emit them around tool calls).
      return p.text.trim() ? replace(i, { ...p, done: true }) : turn.filter((_, j) => j !== i);
    }

    case 'reasoning-start':
      return [...turn, { kind: 'reasoning', id: nextId('reasoning'), sid: part.id, text: '', done: false, startedAt: now }];
    case 'reasoning-delta': {
      const i = bySid('reasoning', part.id);
      if (i < 0) return [...turn, { kind: 'reasoning', id: nextId('reasoning'), sid: part.id, text: part.text, done: false, startedAt: now }];
      const p = turn[i] as Extract<Part, { kind: 'reasoning' }>;
      return replace(i, { ...p, text: p.text + part.text });
    }
    case 'reasoning-end': {
      const i = bySid('reasoning', part.id);
      if (i < 0) return turn;
      const p = turn[i] as Extract<Part, { kind: 'reasoning' }>;
      return replace(i, { ...p, done: true, endedAt: now });
    }

    case 'tool-input-start':
      return [...turn, {
        kind: 'tool', id: part.id, name: part.toolName, inputText: '', status: 'pending', startedAt: now,
      }];
    case 'tool-input-delta': {
      const i = byId('tool', part.id);
      if (i < 0) return turn;
      const p = turn[i] as Extract<Part, { kind: 'tool' }>;
      return replace(i, { ...p, inputText: p.inputText + part.delta });
    }
    case 'tool-call': {
      const i = byId('tool', part.toolCallId);
      const base: Extract<Part, { kind: 'tool' }> = i < 0
        ? { kind: 'tool', id: part.toolCallId, name: part.toolName, inputText: '', status: 'pending', startedAt: now }
        : (turn[i] as Extract<Part, { kind: 'tool' }>);
      const next = { ...base, input: part.input, status: 'running' as const };
      return i < 0 ? [...turn, next] : replace(i, next);
    }
    case 'tool-result': {
      const i = byId('tool', part.toolCallId);
      if (i < 0) return turn;
      const p = turn[i] as Extract<Part, { kind: 'tool' }>;
      // The envelope is the tool output; ok:false is a tool-level
      // failure the model will see and self-correct — show it as such.
      const env = part.output as { ok?: boolean; error?: { code?: string; message?: string } } | undefined;
      const failed = env?.ok === false;
      return replace(i, {
        ...p, input: part.input, output: part.output, endedAt: now,
        status: failed ? 'error' : 'ok',
        error: failed ? `${env?.error?.code ?? 'error'}: ${env?.error?.message ?? ''}` : undefined,
      });
    }
    case 'tool-error': {
      const i = byId('tool', part.toolCallId);
      if (i < 0) return turn;
      const p = turn[i] as Extract<Part, { kind: 'tool' }>;
      return replace(i, { ...p, status: 'error', endedAt: now, error: String((part.error as Error)?.message ?? part.error) });
    }

    case 'error':
      return [...turn, { kind: 'error', id: nextId('err'), message: String((part.error as Error)?.message ?? part.error) }];
    case 'abort':
      return [...turn, { kind: 'note', id: nextId('abort'), text: 'interrupted' }];
    default:
      return turn;
  }
}

/**
 * Split streaming text into blocks that can no longer change and the block
 * still being written. Only lines terminated by a newline are considered —
 * the trailing partial line always stays open.
 */
export function splitBlocks(text: string): { closed: string[]; open: string } {
  const nl = text.lastIndexOf('\n');
  if (nl < 0) return { closed: [], open: text };
  const lines = text.slice(0, nl).split('\n');
  const partial = text.slice(nl + 1);

  const closed: string[] = [];
  let cur: string[] = [];
  let fence: string | null = null;
  // Blank lines seen since the last list line, not yet decided: a list keeps
  // its blank lines (they are how a model writes a sentence per point), so a
  // blank inside one waits for the next line — another item or an indented
  // continuation keeps the list open as one block, anything else closes it.
  // Split per item, each rendered alone and numbered 1. again.
  let held = 0;
  const flush = () => { if (cur.length) { closed.push(cur.join('\n')); cur = []; } held = 0; };
  const inList = () => cur.length > 0 && LIST_ITEM.test(cur[0]);

  for (const line of lines) {
    const f = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (fence) {
      cur.push(line);
      if (f && line.trim().startsWith(fence)) { flush(); fence = null; }
      continue;
    }
    if (f) { flush(); fence = f[1]; cur.push(line); continue; }
    // A blank line ends whatever paragraph or heading came before it.
    if (line.trim() === '') {
      if (inList()) held++; else flush();
      continue;
    }
    if (held) {
      if (LIST_ITEM.test(line) || LIST_CONTINUATION.test(line)) {
        while (held--) cur.push('');
        held = 0;
      } else {
        flush();
      }
    }
    cur.push(line);
  }
  const tail = held ? Array<string>(held).fill('') : [];
  return { closed, open: [...cur, ...tail, partial].join('\n') };
}

/** A bullet or numbered item: `- `, `* `, `+ `, `1. `, `1) `. */
const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s/;
/** Text indented under an item (a second paragraph, a nested block). */
const LIST_CONTINUATION = /^\s{2,}\S/;

/**
 * Split finished parts off the front of the turn (order preserved), and
 * commit any closed blocks of the streaming text part behind them.
 */
export function takeCompleted(turn: Part[]): { done: Part[]; live: Part[] } {
  let i = 0;
  while (i < turn.length && isDone(turn[i])) i++;
  const done = turn.slice(0, i);
  const live = turn.slice(i);

  const head = live[0];
  if (head?.kind === 'text' && !head.done) {
    const { closed, open } = splitBlocks(head.text);
    if (closed.length) {
      // The message's dot rides the FIRST committed block; the rest of the
      // reply, this streaming remainder included, renders with a blank gutter.
      closed.forEach((text, j) =>
        done.push({ kind: 'text', id: nextId('text'), text, done: true, first: j === 0 && head.first }));
      // The committed text is dropped from the live part so it is never drawn twice.
      live[0] = { ...head, text: open, first: false };
    }
  }
  return { done, live };
}

/** Everything in the turn, marked done — used when a turn ends or aborts. */
export function finalize(turn: Part[], now = Date.now()): Part[] {
  return turn.map((p) => {
    if (p.kind === 'text') return { ...p, done: true };
    if (p.kind === 'reasoning') return p.done ? p : { ...p, done: true, endedAt: now };
    if (p.kind === 'tool' && (p.status === 'pending' || p.status === 'running')) {
      return { ...p, status: 'error' as const, error: 'interrupted', endedAt: now };
    }
    return p;
  }).filter((p) => !(p.kind === 'text' && !p.text.trim()));
}

/** The phase word for the status line — `thinking`, `writing`, the tool's
 *  name while it runs, or '' between parts. */
export function phaseLabel(live: Part[]): string {
  for (let i = live.length - 1; i >= 0; i--) {
    const p = live[i];
    if (p.kind === 'tool' && (p.status === 'pending' || p.status === 'running')) return p.name;
    if (p.kind === 'reasoning' && !p.done) return 'thinking';
    if (p.kind === 'text' && !p.done) return 'writing';
  }
  return '';
}

// --- tokens ------------------------------------------------------------------

/**
 * Output tokens this turn, for the status line ("↓ 1.7k tokens"). Every
 * provider reports usage once per step, when the step ends; between those
 * reports the count moves on an estimate from the streamed text (~4 chars a
 * token) so it is never stuck while a long reply streams, and snaps to the
 * real number at each `finish-step`. Provider-agnostic: the AI SDK normalises
 * usage for all of them.
 */
export interface TurnTokens {
  /** Output tokens reported by finished steps. */
  settled: number;
  /** Characters streamed since the last report — the estimate's input. */
  pendingChars: number;
}
export const NO_TOKENS: TurnTokens = { settled: 0, pendingChars: 0 };
const CHARS_PER_TOKEN = 4;

export function applyTokens(t: TurnTokens, part: StreamPart): TurnTokens {
  switch (part.type) {
    case 'text-delta': case 'reasoning-delta':
      return { ...t, pendingChars: t.pendingChars + part.text.length };
    case 'tool-input-delta':
      return { ...t, pendingChars: t.pendingChars + part.delta.length };
    case 'finish-step': {
      const real = part.usage?.outputTokens;
      return { settled: t.settled + (real ?? Math.ceil(t.pendingChars / CHARS_PER_TOKEN)), pendingChars: 0 };
    }
    case 'finish': {
      // The turn's own total, when the provider gives one, beats any sum.
      const real = part.totalUsage?.outputTokens;
      return real != null ? { settled: real, pendingChars: 0 } : t;
    }
    default: return t;
  }
}

/** The number to show: settled plus the estimate for what is in flight. */
export const tokenCount = (t: TurnTokens): number => t.settled + Math.ceil(t.pendingChars / CHARS_PER_TOKEN);

/** 950 → "950", 1700 → "1.7k", 12400 → "12k". */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k < 10 ? `${k.toFixed(1).replace(/\.0$/, '')}k` : `${Math.round(k)}k`;
}

/** 44 → "44s", 124 → "2m 4s". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** Epoch ms → "3:42 pm", local time. By hand, not toLocaleTimeString — the
 * locale must not turn one row's clock into 24h on one machine and 12h with
 * NBSP before "PM" on another. */
export function formatClock(at: number): string {
  const d = new Date(at);
  const h = d.getHours() % 12 || 12;
  return `${h}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'am' : 'pm'}`;
}

// --- resume ------------------------------------------------------------------

/**
 * Render the past: stored messages -> the same Parts the stream would have
 * produced, so a resumed session repaints through the same components. Timings
 * are gone (nothing records them), so thinking blocks are dropped rather than
 * shown with an invented duration — the reasoning stays in the history that
 * goes to the model, it just is not redrawn.
 */
export function messagesToParts(messages: ModelMessage[]): Part[] {
  const parts: Part[] = [];
  const toolAt = new Map<string, number>();

  const textOf = (content: unknown): string =>
    typeof content === 'string'
      ? content
      : (content as { type: string; text?: string }[] ?? [])
          .filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');

  for (const m of messages) {
    if (m.role === 'user') {
      const text = textOf(m.content).trim();
      if (text) parts.push({ kind: 'user', id: nextId('user'), text });
      continue;
    }
    if (m.role === 'assistant') {
      const content = typeof m.content === 'string'
        ? [{ type: 'text', text: m.content }] : m.content;
      for (const c of content as { type: string; [k: string]: unknown }[]) {
        if (c.type === 'text' && String(c.text).trim()) {
          parts.push({ kind: 'text', id: nextId('text'), text: String(c.text), done: true, first: true });
        } else if (c.type === 'tool-call') {
          toolAt.set(String(c.toolCallId), parts.length);
          parts.push({
            kind: 'tool', id: nextId('tool'), name: String(c.toolName),
            inputText: '', input: c.input, status: 'running', startedAt: 0,
          });
        }
      }
      continue;
    }
    if (m.role === 'tool') {
      for (const c of m.content) {
        if (c.type !== 'tool-result') continue;   // approval responses render nothing
        const i = toolAt.get(c.toolCallId);
        if (i === undefined) continue;
        const p = parts[i] as Extract<Part, { kind: 'tool' }>;
        parts[i] = { ...p, ...resultOf(c.output), endedAt: 0 };
      }
    }
  }

  // A tool call whose result never landed (the process died inside the step).
  return parts.map((p) =>
    p.kind === 'tool' && p.status === 'running'
      ? { ...p, status: 'error' as const, error: 'interrupted' }
      : p);
}

/** Unwrap a stored tool output into the fields a tool Part renders. The
 *  envelope travels as JSON, so ok:false is a tool-level failure —
 *  the same reading applyPart gives the live `tool-result` part. */
function resultOf(output: ToolResultPart['output']): Partial<Extract<Part, { kind: 'tool' }>> {
  if (output.type === 'error-text' || output.type === 'error-json') {
    const v = output.value as { message?: string } | string;
    return { status: 'error', error: typeof v === 'string' ? v : v?.message ?? 'error' };
  }
  if (output.type === 'execution-denied') return { status: 'error', error: output.reason ?? 'denied' };
  if (output.type !== 'json' && output.type !== 'text') return { status: 'ok', output: undefined };
  const value = output.value;
  const env = value as { ok?: boolean; error?: { code?: string; message?: string } } | undefined;
  return env?.ok === false
    ? { status: 'error', output: value, error: `${env.error?.code ?? 'error'}: ${env.error?.message ?? ''}` }
    : { status: 'ok', output: value };
}
