// One component per Part kind. The same components render both in <Static>
// (finished) and in the live region (in flight) — the part's own flags decide.
import { Box } from 'ink';
import { Text } from './Text.js';
import Spinner from 'ink-spinner';
import type { ReactNode } from 'react';
import { formatClock, formatElapsed, type Part } from '../state.js';
import { Markdown } from './Markdown.js';

// A tool row is budgeted in RENDERED ROWS, like Codex's exec cell
// (codex-rs/tui/src/exec_cell/render.rs: command continuation 2, output 5):
// a line cap does not bound height — one 2 KB line of minified JSON is a
// single line and twenty rows. The command keeps its HEAD (what ran), the
// output keeps its TAIL (the server keeps the tail too, because errors live
// at the end). ctrl+o — already "show me more" for thinking — lifts both.
const CMD_ROWS = 3;   // the row with the tool name, plus two continuation rows
const OUT_ROWS = 5;
// Byte guards, not display rules: the text still has to be measured and
// handed to yoga, and the kept output can be a megabyte.
const RESULT_BYTES = 4_000;
const EXPANDED_BYTES = 20_000;

// Display width, not code units: the live region is budgeted in screen rows,
// and counting '\n' (as this file used to) does not bound height at all — one
// long paragraph is a single line but many rows.
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{1F300}-\u{1FAFF}]/u;
function cells(s: string): number {
  let n = 0;
  for (const ch of s) n += WIDE.test(ch) ? 2 : 1;
  return n;
}
const rowsFor = (line: string, width: number) => Math.max(1, Math.ceil(cells(line) / width));

/** Keep `maxRows` *rendered rows* of `text`, from the tail (default) or the
 *  head. `omitted` counts the logical lines dropped — stable across widths,
 *  which is what the "… +N lines" marker must report.
 *  `firstWidth` is the room on the first row when something else already sits
 *  there (the tool name); it only applies to a head clip. */
export function clipRows(text: string, width: number, maxRows: number, keep: 'head' | 'tail' = 'tail',
  firstWidth = width): { lines: string[]; omitted: number } {
  const all = text.replace(/\s+$/, '').split('\n');
  const out: string[] = [];
  let used = 0;
  const step = keep === 'head' ? 1 : -1;
  for (let n = 0; n < all.length; n++) {
    const i = keep === 'head' ? n : all.length - 1 - n;
    const r = rowsFor(all[i], out.length === 0 && keep === 'head' ? Math.max(1, firstWidth) : width);
    // A single line taller than the whole budget: keep the end it belongs to,
    // and say so in place — there is no line count to report.
    if (out.length === 0 && r > maxRows) {
      const room = maxRows * width - 2;
      const one = keep === 'head' ? `${all[i].slice(0, room)}…` : `…${all[i].slice(-room)}`;
      return { lines: [one], omitted: all.length - 1 };
    }
    if (used + r > maxRows) return { lines: out, omitted: all.length - out.length };
    if (step === 1) out.push(all[i]); else out.unshift(all[i]);
    used += r;
  }
  return { lines: out, omitted: 0 };
}

/** The one "there is more" marker. The key it names is the way to see it. */
const moreLine = (omitted: number) => `… +${omitted} line${omitted === 1 ? '' : 's'} (ctrl+o)`;

export function PartView({ part, width, expanded, maxRows = 12, userColor, compactTools = false }: {
  part: Part; width: number; expanded: boolean; maxRows?: number;
  /** Colour for what the user said (the voice pane uses a softer one). */
  userColor?: string;
  /** The voice pane: a tool row is just the spinner/dot and the name — no
   *  input summary, no result. The board shows what happened. */
  compactTools?: boolean;
}) {
  switch (part.kind) {
    case 'note': return <Box paddingLeft={2}><Text dimColor>{part.text}</Text></Box>;
    case 'worked': return (
      <Gutter width={width} marker={<Text dimColor>✻</Text>}>
        <Text dimColor>Worked for {formatElapsed(part.ms)} · finished {formatClock(part.at)}</Text>
      </Gutter>
    );
    case 'user': return <UserMessage text={part.text} width={width} color={userColor} />;
    case 'text': return <AssistantText part={part} width={width} maxRows={maxRows} />;
    case 'reasoning': return <Thinking part={part} expanded={expanded} width={width} />;
    case 'tool': return <ToolRow part={part} width={width} expanded={expanded} maxRows={maxRows} compact={compactTools} />;
    case 'error': return (
      <Gutter width={width} marker={<Text color="red">✗</Text>}>
        <Text color="red">{part.message}</Text>
      </Gutter>
    );
  }
}

// The 2-column left gutter every block hangs its marker into (the tool dot,
// the user's ›, the assistant's ●); body text starts at column 2 and wraps
// under itself. Two boxes, not a leading string: a single Text wraps its
// continuation back to column 0.
function Gutter({ marker, width, children }: {
  marker?: ReactNode; width: number; children: ReactNode;
}) {
  return (
    <Box marginTop={1} width={width}>
      <Box width={2} flexShrink={0}>{marker}</Box>
      <Box width={Math.max(1, width - 2)} flexDirection="column">{children}</Box>
    </Box>
  );
}

function UserMessage({ text, width, color }: { text: string; width: number; color?: string }) {
  return (
    <Gutter width={width} marker={<Text color="cyan" bold>{'›'}</Text>}>
      <Text bold color={color}>{text}</Text>
    </Gutter>
  );
}

// Committed blocks render as markdown, once, into <Static>. The block still
// being typed renders as plain text — a half-written block has unbalanced
// markers and reparsing it every token is what shimmers.
function AssistantText({ part, width, maxRows }: {
  part: Extract<Part, { kind: 'text' }>; width: number; maxRows: number;
}) {
  // The dot marks where a reply starts (`first` — one per message segment,
  // however many blocks the reply commits); later blocks get a blank gutter.
  const marker = part.first ? <Text>●</Text> : undefined;
  if (part.done) {
    return (
      <Gutter width={width} marker={marker}>
        <Markdown text={part.text} width={Math.max(1, width - 2)} />
      </Gutter>
    );
  }
  if (!part.text) return null;
  const { lines, omitted } = clipRows(part.text, Math.max(1, width - 2), maxRows);
  return (
    <Gutter width={width} marker={marker}>
      {omitted > 0 && <Text dimColor>…</Text>}
      <Text>{lines.join('\n')}▋</Text>
    </Gutter>
  );
}

// A thought takes no room while it streams: the status line under the live
// region already says `thinking`, and a tail nobody can read is not worth the
// rows it costs (it used to be a header plus four rows, with the status line
// saying "Thinking" again beneath). Finished, it is one dim row — "∴ Thought
// for 4s". ctrl+o shows the whole text, streaming or finished.
function Thinking({ part, expanded, width }: {
  part: Extract<Part, { kind: 'reasoning' }>; expanded: boolean; width: number;
}) {
  if (!expanded && !part.done) return null;
  const secs = Math.max(1, Math.round(((part.endedAt ?? Date.now()) - part.startedAt) / 1000));
  const header = part.done ? `Thought for ${secs}s` : 'Thinking…';
  const body = expanded ? part.text.trim() : '';
  return (
    <Gutter width={width} marker={<Text dimColor italic>{part.done ? '∴' : '∵'}</Text>}>
      <Text dimColor italic>{header}</Text>
      {body && <Text dimColor italic>{body}</Text>}
    </Gutter>
  );
}

function ToolRow({ part, width, expanded, maxRows, compact = false }: {
  part: Extract<Part, { kind: 'tool' }>; width: number; expanded: boolean; maxRows: number; compact?: boolean;
}) {
  const glyph =
    part.status === 'ok' ? <Text color="green">●</Text> :
    part.status === 'error' ? <Text color="red">●</Text> :
    <Text color="yellow"><Spinner type="dots" /></Text>;
  if (compact) {
    return (
      <Box marginTop={1}>
        <Box flexShrink={0}>{glyph}<Text> </Text></Box>
        <Text bold={part.status === 'pending' || part.status === 'running'} dimColor={part.status === 'ok'}
          color={part.status === 'error' ? 'red' : undefined} wrap="truncate">{part.name}</Text>
      </Box>
    );
  }
  // Row budget: the constants, unless the live region hands down a smaller
  // one (it budgets the whole in-flight block in rows — a 20-line heredoc
  // used to ignore that and take the screen).
  const budget = Math.max(2, maxRows);
  const inner = Math.max(1, width - 2);
  const cmd = clipRows(summarizeInput(part.name, part.input, part.inputText), inner,
    expanded ? Infinity : Math.min(CMD_ROWS, Math.max(1, budget - 2)),
    'head', Math.max(1, inner - part.name.length - 1));

  const text = part.status === 'error' ? part.error ?? 'error'
    : part.status === 'ok' ? summarizeOutput(part.output, part.name, expanded) : null;
  // The server keeps the tail of a huge command's output and spills the whole
  // of it to a file. Naming the file is the difference between "cut" and
  // "cut, and here is the rest".
  const spill = spillPath(part.output);
  // What the command block did not use is what the output block may have —
  // markers and the spill line included, so the whole row stays inside the
  // budget the live region set.
  const spent = cmd.lines.length + (cmd.omitted > 0 ? 1 : 0) + (spill ? 1 : 0) + 1;
  const out = text == null ? null
    : clipRows(text, Math.max(1, width - 4), expanded ? Infinity : Math.min(OUT_ROWS, Math.max(1, budget - spent)));
  return (
    <Box marginTop={1} flexDirection="column">
      <Box>
        <Box flexShrink={0}>{glyph}<Text> </Text></Box>
        {/* One Text node: the name and summary flow as a paragraph, wrapping
            between words — two siblings let yoga shrink the name mid-word
            ("kanba/n") in a narrow pane like the Assistant's. */}
        <Text><Text bold>{part.name}</Text><Text dimColor> {cmd.lines.join('\n')}</Text></Text>
      </Box>
      {cmd.omitted > 0 && <Box marginLeft={2}><Text dimColor>{moreLine(cmd.omitted)}</Text></Box>}
      {out != null && (
        <Box marginLeft={2}>
          <Box flexShrink={0}><Text dimColor>⎿ </Text></Box>
          <Text color={part.status === 'error' ? 'red' : undefined} dimColor={part.status !== 'error'}>{out.lines.join('\n')}</Text>
        </Box>
      )}
      {out != null && out.omitted > 0 && <Box marginLeft={4}><Text dimColor>{moreLine(out.omitted)}</Text></Box>}
      {spill && <Box marginLeft={4}><Text dimColor>{`full output: ${spill}`}</Text></Box>}
    </Box>
  );
}

/** The path the server spilled a too-big command's full output to, if any. */
function spillPath(output: unknown): string | null {
  const d = (output as { data?: { truncated?: { full_output?: unknown } } } | undefined)?.data;
  const p = d?.truncated?.full_output;
  return typeof p === 'string' ? p : null;
}

// --- summaries ---------------------------------------------------------------

function summarizeInput(name: string, input: unknown, inputText: string): string {
  const a = (input ?? safeJson(inputText)) as Record<string, unknown> | undefined;
  if (!a) return inputText.slice(0, 80);
  switch (name) {
    case 'bash': return String(a.cmd ?? '');
    case 'read': case 'write': case 'edit': case 'ls': return String(a.path ?? '');
    case 'find': return `${a.pattern ?? ''}${a.path ? ` in ${a.path}` : ''}`;
    case 'grep': return `/${a.pattern ?? ''}/${a.path ? ` in ${a.path}` : ''}`;
    // The default page says nothing worth a line; paging back does — it is
    // the difference between "it looked" and "it went digging".
    case 'session_list': return a.offset ? `from ${a.offset}` : '';
    case 'session_switch': case 'session_read': return a.id ? String(a.id).slice(0, 12) : '';
    default: break;
  }
  // The kanban_* family: the tool NAME carries the verb now, so the summary is
  // just the arguments. Terse on purpose: the Assistant's ~20-column pane.
  if (name.startsWith('kanban_')) {
    const card = a.card !== undefined ? `card ${a.card}` : '';
    switch (name) {
      case 'kanban_card_list': return '';
      case 'kanban_screen': return a.show === 'card' ? card : String(a.show ?? '');
      case 'kanban_card_read': return card;
      case 'kanban_card_create': return `+ "${a.title ?? ''}"${a.status ? ` in ${a.status}` : ''}`;
      case 'kanban_card_move': return `${card} → ${a.status ?? ''}`;
      case 'kanban_card_items': {
        const ops = Array.isArray(a.ops) ? a.ops as { op?: string }[] : [];
        return `${card} ${ops.map((o) => o.op ?? '?').join(', ')}`.slice(0, 80);
      }
      case 'kanban_card_update': {
        const c: string[] = [];
        if (a.status !== undefined) c.push(`→ ${a.status}`);
        if (a.title !== undefined) c.push(`= "${a.title}"`);
        if (a.blocked_reason !== undefined) c.push(a.blocked_reason === null ? 'unblocked' : 'blocked');
        if (a.archived !== undefined) c.push(a.archived ? 'archived' : 'restored');
        for (const f of ['details', 'user_story'])
          if (a[f] !== undefined) c.push(f.replace(/_/g, ' '));
        return `${card} ${c.join(', ') || 'edit'}`.slice(0, 80);
      }
      default: return card;
    }
  }
  return JSON.stringify(a).slice(0, 80);
}

export function summarizeOutput(output: unknown, name?: string, expanded = false): string | null {
  const preview = (text: string) => guard(text, expanded);
  const env = output as { ok?: boolean; data?: unknown } | undefined;
  const d = env && typeof env === 'object' && 'data' in env ? env.data : output;
  // A kanban tool's input line already names the card and the change — a
  // result row repeating it is noise in the narrow pane. Show only what adds
  // information: counts, and errors the handler returned as data.
  if (name?.startsWith('kanban_') && d && typeof d === 'object') {
    const o = d as Record<string, unknown>;
    if (typeof o.error === 'string') return o.error;
    if (Array.isArray(o.cards)) return `${o.cards.length} card${o.cards.length === 1 ? '' : 's'}`;
    return null;
  }
  if (d == null) return 'done';
  if (typeof d === 'string') return preview(d);
  if (Array.isArray(d)) {
    const noun = name === 'web_search' ? 'result' : name === 'web_fetch' ? 'page' : 'item';
    return `${d.length} ${noun}${d.length === 1 ? '' : 's'}`;
  }
  if (typeof d === 'object') {
    const o = d as Record<string, unknown>;
    // An edit answers with the diff; the row says what changed, not the diff.
    if (typeof o.diff === 'string') return summarizeEdit(o);
    // A write answers with the path (already on the input line) and a size.
    if (typeof o.bytes === 'number' && typeof o.path === 'string') return `${formatBytes(o.bytes)} written`;
    if (typeof o.stdout === 'string' || typeof o.stderr === 'string') {
      const text = [o.stdout, o.stderr].filter((s) => typeof s === 'string' && s.trim()).join('\n');
      const code = o.exit_code ?? o.exitCode;
      return `${preview(text) || '(no output)'}${code !== undefined && code !== 0 ? `  [exit ${code}]` : ''}`;
    }
    if (typeof o.content === 'string') return `${o.content.split('\n').length} lines`;
    if (o.image && typeof o.image === 'object') {
      const img = o.image as { media_type?: unknown; bytes?: unknown };
      const size = typeof img.bytes === 'number' ? ` · ${formatBytes(img.bytes)}` : '';
      return `${typeof img.media_type === 'string' ? img.media_type : 'image'}${size}`;
    }
    if (Array.isArray(o.entries)) return `${o.entries.length} entries`;
    if (Array.isArray(o.matches)) return `${o.matches.length} matches`;
    if (Array.isArray(o.files)) return `${o.files.length} files`;
    if (Array.isArray(o.sessions)) return `${o.sessions.length} session${o.sessions.length === 1 ? '' : 's'}`;
    if (Array.isArray(o.cards)) return `${o.cards.length} card${o.cards.length === 1 ? '' : 's'}`;
    if (typeof o.card === 'number') return `card ${o.card}${o.title ? ` "${o.title}"` : ''}${o.status ? ` · ${o.status}` : ''}`;
    return preview(JSON.stringify(o));
  }
  return String(d);
}

/** `1 replacement, exact · +1 −1` — the edit tool's result, counted from the
 *  unified diff it returns (headers and hunk lines excluded). */
function summarizeEdit(o: Record<string, unknown>): string {
  let plus = 0, minus = 0;
  for (const line of String(o.diff).split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) plus++;
    else if (line.startsWith('-') && !line.startsWith('---')) minus++;
  }
  const edits = Array.isArray(o.edits) ? o.edits as { replacements?: unknown; strategy?: unknown }[]
    : [{ replacements: o.replacements, strategy: o.strategy }];
  const n = edits.reduce((sum, e) => sum + (typeof e.replacements === 'number' ? e.replacements : 0), 0);
  const strategies = [...new Set(edits.map((e) => e.strategy).filter((x): x is string => typeof x === 'string'))];
  const what = `${n} replacement${n === 1 ? '' : 's'}${strategies.length ? `, ${strategies.join('/')}` : ''}`;
  return `${what} · +${plus} −${minus}`;
}

// Height is the view's job (clipRows); this is only the guard that keeps a
// megabyte of output from ever reaching yoga. Cut from the END, because the
// view keeps the tail.
function guard(text: string, expanded: boolean): string {
  const cap = expanded ? EXPANDED_BYTES : RESULT_BYTES;
  return text.length > cap ? `… (${formatBytes(text.length)})\n${text.slice(-cap)}` : text;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}
