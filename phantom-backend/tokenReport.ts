// The /tokens report — the text the CLI and Telegram print. Pure: rows in,
// text out. Three windows (today, last 7 days, last 30 days), each the same
// fixed-column table: total, then agents and their rows, then helpers and
// theirs. Cache is a percentage — the share of prompt tokens served from
// cache — since the raw read/write counts say nothing on their own.
import { groupOf, type TokenGroup } from '../core/llm/createAgent.js';
import type { ReportRow, WindowTotals, Windows } from './logTokens.js';

const KIND_W = 14, MODEL_W = 22, NUM_W = 6;
const LABEL_W = 2 + KIND_W + 2 + MODEL_W;  // indent, kind, gutter, model

/** Window starts, from `now`: today's midnight (server timezone), and 7 / 30
 *  days back to the minute. */
export function reportWindows(now: Date): Windows<Date> {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000);
  return { today, week: daysAgo(7), month: daysAgo(30) };
}

/** 1234 → 1.2k, 45000 → 45k, 1234567 → 1.2M. */
const k = (n: number) => n >= 1_000_000 ? `${trim1((n / 1_000_000).toFixed(1))}M`
  : n >= 1_000 ? `${trim1((n / 1_000).toFixed(1))}k`
  : String(n);
const trim1 = (s: string) => s.replace(/\.0$/, '');

const pct = (t: WindowTotals) => t.input ? `${Math.round(t.cacheRead / t.input * 100)}%` : '–';

const clip = (s: string, w: number) => s.length > w ? s.slice(0, w - 1) + '…' : s;
/** Display name for a model: the dated snapshot suffix (`-20250514`) is
 *  noise in a column this narrow. */
const modelName = (r: ReportRow) => (r.model ?? r.provider ?? '?').replace(/-\d{8}$/, '');

const add = (a: WindowTotals, b: WindowTotals): WindowTotals => ({
  input: a.input + b.input, output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead, calls: a.calls + b.calls,
});
const ZERO: WindowTotals = { input: 0, output: 0, cacheRead: 0, calls: 0 };

const line = (label: string, t: WindowTotals) =>
  label.padEnd(LABEL_W)
  + k(t.input).padStart(NUM_W) + k(t.output).padStart(NUM_W)
  + pct(t).padStart(NUM_W) + k(t.calls).padStart(NUM_W);

function table(title: string, window: keyof Windows<unknown>, rows: ReportRow[]): string {
  const live = rows.filter((r) => r[window].calls > 0);
  const out = [
    title,
    ''.padEnd(LABEL_W) + ['in', 'out', 'cache', 'calls'].map((h) => h.padStart(NUM_W)).join(''),
    line('total', live.reduce((a, r) => add(a, r[window]), ZERO)),
  ];
  for (const group of ['agent', 'helper'] as TokenGroup[]) {
    const mine = live.filter((r) => groupOf(r.kind) === group)
      .sort((a, b) => (b[window].input + b[window].output) - (a[window].input + a[window].output));
    out.push(line(`${group}s`, mine.reduce((a, r) => add(a, r[window]), ZERO)));
    for (const r of mine) {
      const kind = clip(r.kind.replace(/_/g, ' '), KIND_W);
      const model = clip(modelName(r), MODEL_W);
      out.push(line(`  ${kind.padEnd(KIND_W + 2)}${model}`, r[window]));
    }
  }
  return out.join('\n');
}

/** The whole report, plain text. Columns hold only in monospace: the CLI
 *  is, Telegram gets it inside a code block. */
export function formatTokenReport(rows: ReportRow[], now: Date): string {
  const today = reportWindows(now).today
    .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return [
    table(`today · ${today}`, 'today', rows), '',
    table('last 7 days', 'week', rows), '',
    table('last 30 days', 'month', rows),
  ].join('\n');
}
