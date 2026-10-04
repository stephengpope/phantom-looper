// The /tokens report — the text the CLI and Telegram print. Pure: rows in,
// text out. Three windows (today, last 7 days, last 30 days), each the same
// fixed-column table: total, then agents and their rows, then helpers and
// theirs. Cache is a percentage — the share of prompt tokens served from
// cache — since the raw read/write counts say nothing on their own.
/** The two kinds of model call: an agent's turn, or a one-shot the system
 *  makes for itself (title, commit_message, compaction, session_digest). */
export type TokenGroup = 'agent' | 'helper';
const HELPER_TYPES = new Set(['title', 'commit_message', 'compaction', 'session_digest']);
export const groupOf = (type: string): TokenGroup => (HELPER_TYPES.has(type) ? 'helper' : 'agent');
import type { ReportRow, WindowTotals, Windows } from './TokenLog.js';
import type { Clock } from '../lib/clock.js';

// NUM_W: widest value `k` emits is 6 (`999.9B`), +4 gutter so columns never touch.
const KIND_W = 14, MODEL_W = 22, NUM_W = 10;
const LABEL_W = 2 + KIND_W + 2 + MODEL_W;  // indent, kind, gutter, model

/** Window starts, from `now`: today's midnight in the builder's zone, and
 *  7 / 30 days back to the minute. */
export function reportWindows(clock: Clock, now: Date): Windows<Date> {
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
  return { today: clock.startOfDay(now), week: daysAgo(7), month: daysAgo(30) };
}

/** 1234 → 1.2k, 45000 → 45.0k, 1234567 → 1.2M, 2e9 → 2.0B. Always one
 *  decimal so every abbreviated value has the same shape down a column. */
const compact = (count: number) => count >= 1e9 ? `${(count / 1e9).toFixed(1)}B`
  : count >= 1e6 ? `${(count / 1e6).toFixed(1)}M`
  : count >= 1e3 ? `${(count / 1e3).toFixed(1)}k`
  : String(count);

const pct = (totals: WindowTotals) => totals.input ? `${Math.round(totals.cacheRead / totals.input * 100)}%` : '–';

const clip = (text: string, width: number) => text.length > width ? text.slice(0, width - 1) + '…' : text;
/** Display name for a model: the dated snapshot suffix (`-20250514`) is
 *  noise in a column this narrow. */
const modelName = (row: ReportRow) => (row.model ?? row.provider ?? '?').replace(/-\d{8}$/, '');

const add = (a: WindowTotals, b: WindowTotals): WindowTotals => ({
  input: a.input + b.input, output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead, calls: a.calls + b.calls,
});
const ZERO: WindowTotals = { input: 0, output: 0, cacheRead: 0, calls: 0 };

const line = (label: string, totals: WindowTotals) =>
  label.padEnd(LABEL_W)
  + compact(totals.input).padStart(NUM_W) + compact(totals.output).padStart(NUM_W)
  + pct(totals).padStart(NUM_W) + compact(totals.calls).padStart(NUM_W);

function table(title: string, window: keyof Windows<unknown>, rows: ReportRow[]): string {
  const live = rows.filter((row) => row[window].calls > 0);
  const out = [
    title,
    ''.padEnd(LABEL_W) + ['in', 'out', 'cache', 'calls'].map((heading) => heading.padStart(NUM_W)).join(''),
    line('total', live.reduce((a, row) => add(a, row[window]), ZERO)),
  ];
  for (const group of ['agent', 'helper'] as TokenGroup[]) {
    const mine = live.filter((row) => groupOf(row.type) === group)
      .sort((a, b) => (b[window].input + b[window].output) - (a[window].input + a[window].output));
    out.push(line(`${group}s`, mine.reduce((a, row) => add(a, row[window]), ZERO)));
    for (const row of mine) {
      const kind = clip(row.type.replace(/_/g, ' '), KIND_W);
      const model = clip(modelName(row), MODEL_W);
      out.push(line(`  ${kind.padEnd(KIND_W + 2)}${model}`, row[window]));
    }
  }
  return out.join('\n');
}

/** The whole report, plain text. Columns hold only in monospace: the CLI
 *  is, Telegram gets it inside a code block. */
export function formatTokenReport(rows: ReportRow[], clock: Clock, now: Date): string {
  const today = clock.date(now, { weekday: 'short', month: 'short', day: 'numeric' });
  return [
    table(`today · ${today}`, 'today', rows), '',
    table('last 7 days', 'week', rows), '',
    table('last 30 days', 'month', rows),
  ].join('\n');
}
