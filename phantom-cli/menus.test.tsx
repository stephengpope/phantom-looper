// Slash commands, the launcher, and the settings screens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { render } from 'ink-testing-library';
import { useState } from 'react';
import { useInput } from 'ink';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { COMMANDS, matches, parse } from './commands.js';
import { ago, lastWorkspaceId, sessionChoices, workspaceChoices, type SessionInfo, type WorkspaceInfo } from './components/Launcher.js';
import { Settings, localRows } from './components/Settings.js';
import { SelectList } from './components/SelectList.js';
import { DEFAULTS, REMOTE_DEFAULTS, type ConfigKey, type ConfigValue } from './config.js';
import { setLocal, localValues } from './local.js';
// The server's own settings module — so this test breaks if the three switches
// ever lose their META entries, rather than passing against a local fake.
import { DEFAULTS as SRV_DEFAULTS, DESCRIPTIONS as SRV_DESCRIPTIONS, META as SRV_META } from '../phantom-backend/settings.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DOWN = '\x1b[B', UP = '\x1b[A', ESC = '\x1b', ENTER = '\r';
const cfgFile = () => join(mkdtempSync(join(tmpdir(), 'phantom-menu-')), 'settings.json');

// ── commands ────────────────────────────────────────────────────────────────
test('typing / filters commands as you go', () => {
  assert.equal(matches('/').length, COMMANDS.length);
  // `/server` and `/settings` diverge at the third letter, so `/set` still
  // reaches settings on its own — which is why the screen is not called
  // `/setup`, where `/se` would have listed two and completed neither.
  assert.deepEqual(matches('/set').map((c) => c.name), ['settings']);
  assert.deepEqual(matches('/ser').map((c) => c.name), ['server']);
  assert.deepEqual(matches('/m').map((c) => c.name), ['model', 'mic']);
  assert.equal(matches('hello').length, 0, 'plain text is not a command');
  // An argument after the command: the menu steps aside, parse keeps the text.
  assert.equal(matches('/assistant hello there').length, 0, 'no menu while typing an argument');
  assert.equal(matches('/assistant ').length, 0, 'a space after a complete name already means an argument follows');
  assert.deepEqual(parse('/assistant hello there'), { command: COMMANDS.find((c) => c.name === 'assistant'), args: 'hello there' });
  assert.equal(parse('/help').args, '');
});

test('a unique prefix resolves; ambiguity and typos are told to the user', () => {
  assert.equal(parse('/settings').command?.name, 'settings');
  assert.equal(parse('/mo').command?.name, 'model');
  assert.match(String(parse('/zzz').error), /unknown command/);
  assert.match(String(parse('/').error), /type a command name/);
});

// ── launcher ────────────────────────────────────────────────────────────────
const NOW = Date.parse('2026-08-21T12:00:00Z');
const W: WorkspaceInfo[] = [
  { id: 'w1', owner: 'sg', name: 'phantom-looper-e2e', cardPrefix: 'PHA' },
  { id: 'w2', owner: 'sg', name: 'knack', displayName: 'Knack', cardPrefix: 'KNA' },
];
const S: SessionInfo[] = [
  { id: 's1', workspaceId: 'w1', branch: 'agent/s1', status: 'active', lastUsedAt: '2026-08-21T10:00:00Z' },
  { id: 's2', workspaceId: 'w2', branch: 'agent/s2', status: 'destroyed', lastUsedAt: '2026-08-14T10:00:00Z',
    lastUserMessage: 'old work' },
];

test('ago is coarse and never lies about the future', () => {
  assert.equal(ago('2026-08-21T11:59:30Z', NOW), 'now');
  assert.equal(ago('2026-08-21T10:00:00Z', NOW), '2h');
  assert.equal(ago('2026-08-14T12:00:00Z', NOW), '7d', 'days stay days for the first week');
  assert.equal(ago('2026-08-07T12:00:00Z', NOW), '2w');
  assert.equal(ago('2026-08-25T12:00:00Z', NOW), 'now', 'clock skew must not print a negative');
});

test('/resume rows: prefix, name AND last message, and dead sessions marked', () => {
  const all = sessionChoices(W, S, (id: string) => id === 's1' ? 'fix the sync lock deadlock' : undefined, NOW);
  // The header is a ROW: its label is the label column's title and its
  // columns carry the titles with the SAME widths the data rows use —
  // SelectList renders both through one layout, so they cannot drift.
  assert.equal(all[0].label, 'ws', 'the header names the label column');
  assert.deepEqual((all[0].columns ?? []).map((c) => c.text), ['card', 'session', 'last message', 'work', 'who', 'when']);
  assert.deepEqual((all[0].columns ?? []).map((c) => c.width),
    (all[1].columns ?? []).map((c) => c.width), 'header and rows share ONE set of widths');
  const rows = all.slice(1);
  const texts = (r: (typeof rows)[0]) => (r.columns ?? []).map((c) => c.text);
  // The workspace column is its card prefix, the server's resolved value.
  assert.equal(rows[0].label, 'PHA');
  // Columns are SelectList Column cells (the list aligns them), in order:
  // card · session name · last message · work · who · when.
  assert.deepEqual(texts(rows[0]), ['·', '·', '"fix the sync lock deadlock"', '·', 'manual', '2h']);
  // A named session shows BOTH: its name and the last message.
  const named = sessionChoices(W, [{ ...S[0], name: 'sync lock deadlock fix' }],
    () => 'short question', NOW).slice(1);
  assert.deepEqual(texts(named[0]), ['·', 'sync lock deadlock fix', '"short question"', '·', 'manual', '2h']);
  // The card column: the BARE number beside the prefix the ws column already
  // shows (the board's own shape — prefix in the header, number on the row),
  // for either seat of a loop; a session with no card is the blank-fact dot.
  const carded = sessionChoices(W, [{ ...S[0], card: 7, agent: 'coding' }, { ...S[0], id: 's3', card: 7, agent: 'supervisor' }],
    () => 'q', NOW, () => false, () => false, '', true).slice(1);
  assert.deepEqual(carded.map((r) => texts(r)[0]), ['7', '7'], 'coding and supervisor seats both name the card');
  // who = the seat the looper drives it from, by name.
  assert.equal(texts(carded[0])[4], 'coder');
  assert.equal(texts(carded[1])[4], 'supervisor');
  // A card session a person typed into (the server clears `agent` on their
  // save) is theirs: `manual`, card number kept — the card link is permanent,
  // who drives it is not.
  const taken = sessionChoices(W, [{ ...S[0], card: 7, agent: null }], () => 'q', NOW).slice(1);
  assert.deepEqual([texts(taken[0])[0], texts(taken[0])[4]], ['7', 'manual']);
  assert.equal(texts(rows[0])[0], '·', 'a manual session has no card');
  // A server without cardPrefix falls back to the workspace label.
  const bare = sessionChoices([{ id: 'w1', owner: 'sg', name: 'phantom-looper-e2e' }], [S[0]],
    () => 'q', NOW).slice(1);
  assert.equal(bare[0].label, 'phantom-looper-e2e');
  // A destroyed session still lists, marked, instead of vanishing.
  assert.equal(texts(rows[1])[5], 'ended');
  assert.match(String(rows[1].hint), /reopening restarts it/);
  // No name, no message: dots — never the branch, which is a session id.
  // (Only an open or running session can be this blank and still list.)
  const blank = texts(sessionChoices(W, S, () => undefined, NOW, () => false, (id) => id === 's1')[1]);
  assert.deepEqual([blank[1], blank[2]], ['·', '·']);
  // Nothing to resume says so rather than showing an empty box.
  assert.match(String(sessionChoices(W, [], () => undefined, NOW)[0].label), /no sessions yet/);
});

test('/resume\'s work column: the server\'s git fact in the operator\'s words, dot when absent', () => {
  const texts = (r: { columns?: { text: string }[] }) => (r.columns ?? []).map((c) => c.text);
  const at = (work: SessionInfo['work']) =>
    texts(sessionChoices(W, [{ ...S[0], work }], () => 'q', NOW).slice(1)[0])[3];
  assert.equal(at('not_pushed'), 'not pushed', 'work only on the server\'s disk');
  assert.equal(at('not_merged'), 'not merged', 'on origin\'s branch, not in base');
  assert.equal(at('merged'), 'merged');
  // Null (nothing to measure) and absent (list fetched without git=true —
  // the instant first paint) are both the blank-fact dot, never empty.
  assert.equal(at(null), '·');
  assert.equal(at(undefined), '·');
});

test('/resume\'s work column carries a severity mark: red not pushed, yellow not merged, green merged', () => {
  // The mark is a colored • SelectList draws ahead of the words — red for
  // work that exists only on the server's disk (trashing loses it), yellow
  // for on origin but not in base, green for done. The blank-fact dot
  // carries NO mark: a color would claim a state the server did not give.
  const workCol = (work: SessionInfo['work']) =>
    (sessionChoices(W, [{ ...S[0], work }], () => 'q', NOW).slice(1)[0].columns ?? [])[3];
  assert.equal(workCol('not_pushed').mark, 'red');
  assert.equal(workCol('not_merged').mark, 'yellow');
  assert.equal(workCol('merged').mark, 'green');
  assert.equal(workCol(null).mark, undefined);
  assert.equal(workCol(undefined).mark, undefined);
  // The header names the column, unmarked.
  assert.equal((sessionChoices(W, S, () => 'q', NOW)[0].columns ?? [])[3].mark, undefined);
  // The fixed width holds the mark (2), the longest words (10) and the
  // gutter (2) — a marked cell must never truncate into its gutter.
  assert.equal(workCol('not_pushed').width, 14);
});

test('/resume lists what the server sends: the filters are the query, [s] re-reads without one, and an open session with nothing typed is merged in last', async () => {
  const sid = (r: { value: unknown }) => (r.value as { sessionId?: string } | null)?.sessionId;
  // The row builder keeps every row it is handed — which sessions are listed
  // is the server's call (typed=true, supervisor=false), not this function's.
  assert.deepEqual(sessionChoices(W, S, () => undefined, NOW).slice(1).map(sid), ['s1', 's2']);

  // App: every list read carries the filters; the session open HERE (s1,
  // nothing typed, so absent from the server's list) is merged in with its
  // dot — the switcher never hides an open session — and sorts LAST: nothing
  // typed is no activity, never ahead of real work.
  const lists: string[] = [];
  const api = async (m: string, path: string) => {
    if (path === '/workspaces') return W;
    if (path.split('?')[0] === '/sessions' && m === 'GET') { lists.push(path); return { sessions: [S[1]], total: 1 }; }
    return {};
  };
  const { stdin, lastFrame } = app({ api: settingsApi({}, [], api) });
  await sleep(50);
  stdin.write('/resume'); await sleep(40);
  stdin.write(ENTER); await sleep(140);
  assert.ok(lists.length > 0 && lists.every((p) => /typed=true/.test(p) && /supervisor=false/.test(p)),
    `the server filters, every read: ${lists.join(' ')}`);
  // The ws column is the card prefix (KNA = w2, PHA = w1).
  const rows = strip(lastFrame() ?? '').split('\n').filter((l) => /\b(KNA|PHA)\b/.test(l));
  assert.equal(rows.length, 2, 'the server row and the open one');
  assert.match(rows[0], /KNA.*old work/, 'the server row first');
  assert.match(rows[1], /•.*PHA/, 'then the open session, marked open');
  assert.ok(!/↓ \d+ more/.test(strip(lastFrame() ?? '')), 'two of two: nothing below — the count is the total, not a guess');
  // [s]: the seats come in — a re-read WITHOUT the supervisor switch.
  const before = lists.length;
  stdin.write('s'); await sleep(140);
  assert.ok(lists.slice(before).some((p) => /typed=true/.test(p) && !/supervisor=false/.test(p)),
    `[s] re-reads with the seats in: ${lists.slice(before).join(' ')}`);
});

test('boot_last_workspace picks the newest user-driven session\'s workspace', () => {
  // s1 (w1) is newer than s2 (w2) — w1 wins. s2 being destroyed changes
  // nothing: a swept session is still where you were.
  assert.equal(lastWorkspaceId(W, S), 'w1');
  // A looper-run session is not "where you were", however fresh.
  const looper: SessionInfo = { id: 's3', workspaceId: 'w2', branch: 'agent/s3', status: 'active',
    lastUsedAt: '2026-08-21T11:00:00Z', agent: 'coding' };
  assert.equal(lastWorkspaceId(W, [...S, looper]), 'w1');
  // A session whose workspace is gone cannot be booted into.
  const orphan: SessionInfo = { id: 's4', workspaceId: 'gone', branch: 'agent/s4', status: 'active',
    lastUsedAt: '2026-08-21T11:30:00Z' };
  assert.equal(lastWorkspaceId(W, [...S, orphan]), 'w1');
  // Transport order is not trusted: oldest-first input still picks by time.
  assert.equal(lastWorkspaceId(W, [...S].reverse()), 'w1');
  assert.equal(lastWorkspaceId(W, []), undefined, 'nothing eligible: the picker stays');
  // The server declares the key — the boot path reads it off /settings.
  assert.equal(SRV_DEFAULTS.boot_last_workspace, false);
  assert.equal(SRV_META.boot_last_workspace.type, 'boolean');
  assert.ok(SRV_DESCRIPTIONS.boot_last_workspace.length > 0);
});

test('/resume rows mark a session running a turn in this window', () => {
  // One fact, one place: the SPINNER says running; the when column stays
  // time-only. No words repeating what the marker already says.
  const rows = sessionChoices(W, S, () => undefined, NOW, (id) => id === 's1').slice(1);
  const texts = (r: (typeof rows)[0]) => (r.columns ?? []).map((c) => c.text);
  assert.equal(rows[0].busy, true, 'running = spinner');
  assert.ok(!texts(rows[0]).some((t) => /working/.test(t)), 'no activity words in the columns');
  // A dead session cannot be working, whatever the store claims.
  const dead = sessionChoices(W, S, () => undefined, NOW, () => true).slice(1)[1];
  assert.equal(texts(dead)[5], 'ended');
  assert.equal(dead.busy, false);
  // Without the lookup the row falls back to the timestamp, as before.
  assert.equal(texts(sessionChoices(W, S, () => 'q', NOW)[1])[5], '2h');
});

test('/resume rows mark a session loaded in this window with a steady dot', () => {
  // Loaded-but-idle: the dot takes the spinner's slot, the timestamp stays,
  // and the hint says enter switches rather than reopens.
  const rows = sessionChoices(W, S, () => undefined, NOW, () => false, (id) => id === 's1').slice(1);
  assert.equal(rows[0].dot, true);
  assert.equal((rows[0].columns ?? [])[5]?.text, '2h');
  assert.match(String(rows[0].hint), /loaded in this window/);
  // Working beats the dot — the spinner already says it is in memory.
  const working = sessionChoices(W, S, () => undefined, NOW, () => true, () => true).slice(1)[0];
  assert.equal(working.busy, true);
  assert.equal(working.dot, false);
  // A dead session is not "open", whatever the store claims.
  const dead = sessionChoices(W, S, () => undefined, NOW, () => false, () => true).slice(1)[1];
  assert.equal(dead.dot, false);
  // Not loaded: no dot, hint stays the bare branch.
  const idle = sessionChoices(W, S, () => 'q', NOW).slice(1)[0];
  assert.equal(idle.dot, false);
  assert.equal(idle.hint, 'agent/s1');
});

test('workspace rows use the display name when one is set', () => {
  const rows = workspaceChoices(W, false);      // without the trailing "add…"
  assert.deepEqual(rows.map((r) => r.label), ['phantom-looper-e2e', 'Knack']);
  assert.deepEqual(rows.map((r) => r.value), [
    { kind: 'new', workspaceId: 'w1' }, { kind: 'new', workspaceId: 'w2' },
  ]);
});

// ── settings rows ───────────────────────────────────────────────────────────
test('local rows are grouped, and a server-held key shows beside a local one', () => {
  // One screen over two homes. Which home a row came from is printed on it,
  // which is what makes that safe to read.
  const cfg = { ...REMOTE_DEFAULTS, ...localValues(cfgFile(), {}),
    anthropic_api_key: 'sk-a' } as unknown as Record<ConfigKey, ConfigValue>;
  const labels = localRows(cfg).map((r) => r.label);
  assert.ok(labels.includes('model'), 'group heading');
  assert.ok(!labels.includes('endpoint'), 'anthropic ignores the endpoint');
  assert.ok(labels.includes('api key'), 'the server key row is on setup');
});

test('secrets render as their last four, unset says so', () => {
  const f = cfgFile();
  setLocal('server_key', 'sk-ant-000000007c21', f);
  const rows = localRows({ ...REMOTE_DEFAULTS, ...localValues(f, {}) } as unknown as Record<ConfigKey, ConfigValue>);
  const key = rows.find((r) => r.label === 'api key')!;
  assert.equal(key.shown, '••••7c21');
  assert.ok(!key.shown.includes('sk-ant'), 'the key itself never reaches the screen');
});

// ── settings screen ─────────────────────────────────────────────────────────
/** A fake API that answers the settings routes — the screens read what is
 *  STORED now, so a test has to store something. Values default to the code
 *  defaults, which is what an unset key resolves to on a real server. */
function settingsApi(values: Record<string, unknown> = {}, calls: string[] = [],
  rest?: (m: string, p: string, b?: unknown) => Promise<unknown>) {
  const wrap = (o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v, secret: false }]));
  const stored: Record<string, unknown> = { ...REMOTE_DEFAULTS, ...values };
  return async (method: string, path: string, body?: unknown) => {
    calls.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''}`);
    if (!path.startsWith('/settings')) return rest ? rest(method, path, body) : {};
    // A real store: a write is visible to the next read, which is what the
    // screens now depend on.
    if (method === 'PATCH') { Object.assign(stored, body as object); return {}; }
    if (method !== 'GET') return {};
    return wrap(stored);
  };
}
const noApi = settingsApi();

test('the settings screen shows every value with where it came from', async () => {
  const f = cfgFile();
  const { lastFrame } = render(
    <Settings api={settingsApi({ model: 'claude-sonnet-5' })} configPath={f}
      startAt="local" onClose={() => {}} />);
  await sleep(50);
  const frame = strip(lastFrame() ?? '');
  assert.match(frame, /model/);
  assert.match(frame, /claude-sonnet-5\s+server/, 'a server-held value says so');
});

test('an env override is named on screen, so "it did not take" is answerable', async () => {
  // Env reaches only the local keys now, so a value on the server can never be
  // shadowed by something in your shell — and where it CAN happen, it is named.
  const f = cfgFile();
  setLocal('server_url', 'http://from-file', f);
  process.env.PHANTOM_BACKEND_URL = 'http://from-env';
  try {
    const { lastFrame } = render(
      <Settings api={noApi} configPath={f} startAt="local" onClose={() => {}}
        groups={['server']} />);
    await sleep(50);
    const frame = strip(lastFrame() ?? '');
    assert.match(frame, /http:\/\/from-env/);
    assert.match(frame, /PHANTOM_BACKEND_URL/, 'the screen names the variable to unset');
  } finally { delete process.env.PHANTOM_BACKEND_URL; }
});

test('d resets a local setting to the default and rewrites the file', async () => {
  const f = cfgFile();
  setLocal('server_url', 'http://x', f);
  assert.equal(localValues(f, {}).server_url, 'http://x');
  const { stdin } = render(
    <Settings api={noApi} configPath={f} startAt="local" onClose={() => {}}
      groups={['server']} />);
  await sleep(50);
  stdin.write('d'); await sleep(50);
  assert.equal(localValues(f, {}).server_url, DEFAULTS.server_url, 'back to the code default');
});

test('editing a server-held setting PATCHes it rather than writing the file', async () => {
  const f = cfgFile();
  const calls: string[] = [];
  const api = settingsApi({}, calls);
  const { stdin } = render(
    <Settings api={api} configPath={f} startAt="local" onClose={() => {}} groups={['model']} />);
  await sleep(50);
  stdin.write('\r'); await sleep(50);       // open the first model row (provider)
  stdin.write('\u001B[B'); await sleep(20); // next choice
  stdin.write('\r'); await sleep(60);
  assert.ok(calls.some((c) => c.startsWith('PATCH /settings')),
    `a client setting goes to its own namespace: ${calls.join(' | ')}`);
  assert.equal(existsSync(f), false, 'and nothing was written to the local file');
});


test('esc from a scoped screen closes rather than falling into a scope list', async () => {
  let closed = 0;
  const { stdin } = render(
    <Settings api={noApi} configPath={cfgFile()} startAt="local" onClose={() => { closed++; }} />);
  await sleep(50);
  stdin.write(ESC); await sleep(60);
  assert.equal(closed, 1);
});

test('server settings: the auto-push/credential switches render as pickers', async () => {
  // /settings is generic — it draws whatever GET /settings declares — so the
  // switches need no TUI code, only correct META. Prove that: feed
  // the REAL server META and check the editor it produces.
  const keys = ['auto_push_on_archive', 'agent_git_credentials'] as const;
  const server = Object.fromEntries(keys.map((k) => [k, {
    value: SRV_DEFAULTS[k], source: 'default',
    description: SRV_DESCRIPTIONS[k], meta: SRV_META[k],
  }]));
  const api = async () => server;
  const { lastFrame, stdin } = render(
    <Settings api={api} configPath={cfgFile()} startAt="api" onClose={() => {}} />);
  await sleep(80);

  let f = strip(lastFrame() ?? '');
  for (const k of keys) assert.match(f, new RegExp(SRV_META[k].label!),
    `${k} is missing from the server list`);
  // Values and names are shown as a person would say them (META.label), rows
  // gathered under their wire group's heading.
  assert.match(f, /git/, 'the group heading is drawn');
  assert.match(f, /auto-push on archive\s+no\s+default/, 'auto_push_on_archive defaults off');
  assert.match(f, /agent github access\s+no\s+default/, 'agent_git_credentials defaults off');

  // auto_push_on_archive: a boolean, so the editor is a yes/no picker.
  stdin.write(ENTER); await sleep(60);
  f = strip(lastFrame() ?? '');
  assert.match(f, /auto-push on archive/);
  assert.match(f, /no\s+current value/, 'the current value is marked');
  assert.match(f, /yes/);
  stdin.write(ESC); await sleep(40);
});

test('a corrupt settings file is surfaced, not silently swallowed', async () => {
  const f = cfgFile();
  writeFileSync(f, '{ broken');
  const { lastFrame } = render(
    <Settings api={noApi} configPath={f} startAt="local" onClose={() => {}} />);
  await sleep(50);
  assert.match(strip(lastFrame() ?? ''), /not valid JSON/);
  assert.equal(readFileSync(f, 'utf8'), '{ broken', 'and the file is left alone');
});

test('server scope reads the API and renders meta-driven rows', async () => {
  const api = async (method: string, path: string) => {
    assert.equal(`${method} ${path}`, 'GET /settings');
    return {
      spare_clones: { value: 2, source: 'default', description: 'Warm clones kept ready.',
        meta: { type: 'number', unit: 'count' } },
      auto_push_fix_provider: { value: 'anthropic', source: 'override', description: 'LLM provider for conflicts.',
        meta: { type: 'string', choices: ['anthropic', 'openai'] } },
    };
  };
  const { lastFrame } = render(
    <Settings api={api} configPath={cfgFile()} startAt="api" onClose={() => {}} />);
  await sleep(80);
  const frame = strip(lastFrame() ?? '');
  assert.match(frame, /spare clones/);
  assert.match(frame, /2\s+default/);
  assert.match(frame, /anthropic\s+custom/);
  assert.match(frame, /applies to everyone/, 'the blast radius is stated');
});

test('an unreachable server says so instead of hanging on a spinner', async () => {
  const api = async () => { throw new Error('connect ECONNREFUSED'); };
  const { lastFrame } = render(
    <Settings api={api} configPath={cfgFile()} startAt="api" onClose={() => {}} />);
  await sleep(80);
  assert.match(strip(lastFrame() ?? ''), /server unreachable/);
});

// ── App: slash routing ──────────────────────────────────────────────────────
import { App } from './App.js';
import { Transcript } from './session.js';
import type { ModelMessage, Tool } from 'ai';

const noTools = async () => ({} as Record<string, Tool>);
const throwaway = () => new Transcript(
  { type: 'session', session_id: 's1', workspace: 'w1', branch: 'agent/s1',
    provider: 'test', model: 'fake', created_at: '2026-08-21T12:00:00Z' },
  join(mkdtempSync(join(tmpdir(), 'phantom-app-')), 'x.jsonl'));
const INITIAL = { sessionId: 's1', branch: 'agent/s1', workspaceId: 'w1',
  tools: {} as Record<string, Tool>, resumed: [] as ModelMessage[] };
const stubAgent = () => ({
  agent: { stream: async () => { throw new Error('should not run for a command'); } } as never,
  summary: { provider: 'test', model: 'fake', reasoning: 'none', maxSteps: 40 },
});

function app(over: Partial<Parameters<typeof App>[0]> = {}) {
  return render(<App api={noApi} initial={INITIAL} newTools={noTools}
    makeAgent={stubAgent} makeTranscript={throwaway} loadHistory={() => []}
    configPath={cfgFile()} {...over} />);
}

test('typing / shows the command list above the prompt', async () => {
  const { stdin, lastFrame } = app();
  await sleep(50);
  stdin.write('/');
  await sleep(60);
  const f = strip(lastFrame() ?? '');
  assert.match(f, /\/plan/);
  assert.match(f, /\/model/);
  assert.match(f, /\/workspace/);
});

test('/help lists the commands and never reaches the model', async () => {
  const { stdin, frames } = app();
  await sleep(50);
  stdin.write('/help'); await sleep(40);
  stdin.write(ENTER); await sleep(80);
  const all = strip(frames.join('\n'));
  assert.match(all, /\/new\s+new session in this workspace/);
});

test('an unknown command is answered by the UI, not sent as a prompt', async () => {
  const { stdin, frames } = app();
  await sleep(50);
  stdin.write('/nope'); await sleep(40);
  stdin.write(ENTER); await sleep(80);
  assert.match(strip(frames.join('\n')), /unknown command \/nope/);
});

test('/plan flips plan mode: the row is PATCHed, the kit rebuilds readonly, the toolbar marks it', async () => {
  const calls: string[] = [];
  const picks: (boolean | undefined)[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    calls.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''}`);
    return {};
  };
  const { stdin, lastFrame } = app({ api,
    newTools: async (_id: string, plan?: boolean) => { picks.push(plan); return {}; } });
  await sleep(50);
  // The mark is ALWAYS on: a fresh session says code mode before you type.
  assert.match(strip(lastFrame() ?? ''), /» code mode on/, 'code mode is announced from the start');
  stdin.write('/plan'); await sleep(40);
  stdin.write(ENTER); await sleep(150);
  // The server row is the record — PATCH first, then this window's kit.
  assert.ok(calls.includes('PATCH /sessions/s1 {"plan_mode":true}'), `PATCH landed: ${calls.join(' | ')}`);
  assert.deepEqual(picks, [true], 'the rebuild asked for the plan kit');
  const on = strip(lastFrame() ?? '');
  assert.match(on, /» plan mode on/, 'the mark flips while plan mode is on');
  assert.ok(!/» code mode/.test(on), 'one mode at a time');
  stdin.write('/plan'); await sleep(40);
  stdin.write(ENTER); await sleep(150);
  assert.ok(calls.includes('PATCH /sessions/s1 {"plan_mode":false}'));
  assert.deepEqual(picks, [true, false], 'the full kit came back');
  const f = strip(lastFrame() ?? '');
  assert.match(f, /» code mode on/, 'and back');
  assert.ok(!/» plan mode/.test(f), 'the plan mark is gone');
});

test('the toolbar names the card a session is building, the board\'s way, and says nothing when there is none', async () => {
  // Opening a looper session: the row carries its card (the loop's), the
  // workspace read carries the prefix — the mark is the two put together.
  const row = { id: 's9', workspaceId: 'w1', branch: 'agent/s9', status: 'active',
    lastUsedAt: '2026-08-21T10:00:00Z', lastUserMessage: 'build the card', card: 7 };
  const api = async (method: string, path: string) => {
    if (path === '/workspaces') return [{ id: 'w1', owner: 'sg', name: 'widgets', cardPrefix: 'PHA' }];
    if (path.split('?')[0] === '/sessions') return { sessions: [row], total: ([row]).length };
    if (path === '/sessions/s9') return row;
    if (path === '/workspaces/w1') return { name: 'widgets', cardPrefix: 'PHA' };
    if (path.endsWith('/transcript')) return { data: null };
    return {};
  };
  const r = app({ api, newTools: async () => ({}) });
  try {
    await sleep(50);
    r.stdin.write('/resume'); await sleep(40);
    r.stdin.write(ENTER); await sleep(160);       // the list opens
    r.stdin.write(ENTER); await sleep(200);       // open the card's session
    assert.match(strip(r.lastFrame() ?? ''), /» code mode on · PHA-7/,
      'the card rides beside the mode, named as the board names it');
  } finally { r.unmount(); }

  // A session you started yourself belongs to no card: no mark, no chatter.
  const plain = app({ api: noApi, newTools: noTools });
  try {
    await sleep(50);
    const f = strip(plain.lastFrame() ?? '');
    assert.match(f, /» code mode on/);
    assert.ok(!/PHA-/.test(f), 'nothing about cards on a session that has none');
  } finally { plain.unmount(); }
});

test('session_get_mode and screen_enter_plan_mode ride the coding kit: report, one-way switch, no path back', async () => {
  const calls: string[] = [];
  // The sessions TABLE, not a stand-in for it: plan_mode lives on the row and
  // the PATCH is what moves it — session_get_mode must read it back from here.
  const row = { planMode: false };
  const api = async (method: string, path: string, body?: unknown) => {
    calls.push(`${method} ${path}${body ? ` ${JSON.stringify(body)}` : ''}`);
    if (method === 'PATCH' && path === '/sessions/s1'
      && typeof (body as { plan_mode?: boolean })?.plan_mode === 'boolean') {
      row.planMode = (body as { plan_mode: boolean }).plan_mode;
    }
    if (method === 'GET' && path === '/sessions/s1') return { ...row };
    return {};
  };
  const kits: Record<string, Tool>[] = [];
  const { lastFrame } = app({ api, newTools: async () => ({}),
    makeAgent: ((tools: Record<string, Tool>) => { kits.push(tools); return stubAgent(); }) as never });
  await sleep(50);
  const t = (name: string) => kits[kits.length - 1][name] as unknown as
    { execute: (a: unknown, o: unknown) => Promise<unknown> };
  assert.deepEqual(await t('session_get_mode').execute({}, {}), { mode: 'code' });
  assert.deepEqual(await t('screen_enter_plan_mode').execute({}, {}), { ok: true });
  assert.ok(calls.includes('PATCH /sessions/s1 {"plan_mode":true}'), 'the row is the record');
  await sleep(30);
  assert.match(strip(lastFrame() ?? ''), /» plan mode on/, 'the toolbar followed the tool');
  // The rebuilt kit reports the new mode; the way back is the user's alone.
  assert.deepEqual(await t('session_get_mode').execute({}, {}), { mode: 'plan' });
  assert.deepEqual(await t('screen_enter_plan_mode').execute({}, {}),
    { ok: false, error: 'already in plan mode' });
  assert.ok(!calls.some((c) => c.includes('"plan_mode":false')), 'no way back from an agent — /plan only');
});

test('/settings goes straight to the server settings and says whose they are', async () => {
  const api = async () => ({
    spare_clones: { value: 2, source: 'default', description: 'Warm clones.', meta: { type: 'number' } },
  });
  const { stdin, lastFrame } = app({ api });
  await sleep(50);
  stdin.write('/settings'); await sleep(40);
  stdin.write(ENTER); await sleep(120);
  const f = strip(lastFrame() ?? '');
  assert.match(f, /spare clones/, 'no scope menu to walk through first');
  assert.match(f, /applies to everyone/, '"settings" alone reads personal, so say it is not');
  assert.ok(!/type a message/.test(f), 'the typing area is replaced while a menu is open');
  stdin.write(ESC); await sleep(60);
  assert.match(strip(lastFrame() ?? ''), /type a message/, 'esc gives the prompt back');
});

test('/server edits the url and token, and never touches the network', async () => {
  const api = async (m: string, p: string) => { throw new Error(`${m} ${p} must not happen`); };
  const { stdin, lastFrame } = app({ api, configPath: cfgFile() });
  await sleep(50);
  stdin.write('/server'); await sleep(40);
  stdin.write(ENTER); await sleep(120);
  const f = strip(lastFrame() ?? '');
  assert.match(f, /server url/);
  assert.match(f, /api key/);
  assert.ok(!/steps per turn|anthropic key/.test(f), 'model settings are a different command');
});

test('switching session never writes raw escape codes: the pane is redrawn, the terminal is left alone', async () => {
  const { stdin, frames } = app();
  await sleep(50);
  stdin.write('/new'); await sleep(40);
  stdin.write(ENTER); await sleep(140);
  // Raw frames, unstripped: this is what actually reached the terminal. The
  // whole screen is drawn live now (alternate screen); a hand-written clear
  // would fight Ink's own repaint.
  const raw = frames.join('');
  assert.ok(!raw.includes('\x1b[2J'), 'no 2J');
  assert.ok(!raw.includes('\x1b[3J'), 'no 3J');
});

test('/model is a shortcut, not a second door into every local setting', async () => {
  const { stdin, lastFrame } = app();
  await sleep(50);
  stdin.write('/model'); await sleep(40);
  stdin.write(ENTER); await sleep(90);
  const f = strip(lastFrame() ?? '');
  assert.match(f, /provider/);
  assert.match(f, /reasoning/);
  assert.match(f, /steps per turn/);
  assert.ok(!/server url|api key/.test(f), 'the connection is a different command');
  stdin.write(ESC); await sleep(60);
  assert.match(strip(lastFrame() ?? ''), /type a message/, 'esc returns to the prompt');
});

test('a model change is recorded in the transcript as a non-message event', async () => {
  const f = cfgFile();
  const t = throwaway();
  // Two builds that differ, so the switch is real rather than a no-op.
  let call = 0;
  const swap = () => ({
    agent: { stream: async () => { throw new Error('unused'); } } as never,
    summary: { provider: 'test', model: call++ === 0 ? 'fake' : 'fake-2', reasoning: 'none', maxSteps: 40 },
  });
  const { stdin, frames } = render(<App api={noApi} initial={INITIAL} newTools={noTools}
    makeAgent={swap} makeTranscript={() => t} loadHistory={() => []} configPath={f} />);
  await sleep(50);
  stdin.write('/model'); await sleep(50);
  stdin.write(ENTER); await sleep(100);   // submit /model -> the menu opens
  stdin.write(ENTER); await sleep(100);   // open `provider`
  stdin.write(ENTER); await sleep(400);   // accept -> a write, then a re-read
  assert.match(strip(frames.join('\n')), /model → test\/fake-2/, 'the switch is announced');
  const lines = readFileSync(t.path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const event = lines.find((l) => l.type === 'model');
  assert.ok(event, 'a {type:"model"} line is written');
  assert.equal(event.model, 'fake-2');
  // And replay ignores it: loadTranscript keeps only the header and messages.
  const { loadTranscript } = await import('./session.js');
  assert.equal(loadTranscript('unused', t.path).messages.length, 0);
});

test('/new starts another session in the same workspace, in the same window', async () => {
  const calls: string[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    calls.push(`${method} ${path} ${JSON.stringify(body ?? {})}`);
    // The create response carries the prompt facts (skills + git), so the
    // open needs no follow-up read.
    return { id: 's2', branch: 'agent/s2', workspaceId: 'w1', status: 'active',
      skills: [], agent_git_credentials: false };
  };
  const seen: string[] = [];
  const { stdin } = app({ api, newTools: async () => ({}), onSession: (s) => seen.push(`${s.id} ${s.branch}`) });
  await sleep(50);
  stdin.write('/new'); await sleep(40);
  stdin.write(ENTER); await sleep(120);
  // The elsewhere-watch polls `GET /sessions/<id>` and the task count polls
  // `GET /sessions/<id>/tasks` on their own clocks; the open path is what
  // this test pins, so those reads are not counted.
  const relevant = calls.filter((c) => !c.includes('/settings') && !c.includes('/tasks')
    && !/^GET \/sessions\/\w+ /.test(c));
  assert.equal(relevant[0], 'POST /sessions {"workspace_id":"w1"}', 'same workspace, no picker');
  // Opening READS — it never takes the lock (locks are per turn now): the
  // create is followed straight by the transcript pull.
  assert.ok(!relevant.some((c) => c.includes('/lock')), 'no lock call on open — locks are per turn');
  assert.match(relevant[1] ?? '', /^GET \/sessions\/s2\/transcript/, 'opening pulls the record');
  // The banner names the workspace: one lookup, cached per workspace for the
  // window's life (launch seeds the cache in production; this App has none).
  assert.match(relevant[2] ?? '', /^GET \/workspaces\/w1/, 'the banner looks the workspace name up once');
  assert.equal(relevant.length, 3);
  assert.deepEqual(seen, ['s2 agent/s2'], 'the new session is on screen');
});

test('/resume lists earlier sessions and opens the chosen one in place', async () => {
  const sessions = [
    { id: 's9', workspaceId: 'w1', branch: 'agent/s9', status: 'active', lastUsedAt: '2026-08-21T10:00:00Z',
      lastUserMessage: 'start the work' },
  ];
  const api = async (method: string, path: string) => {
    if (path === '/workspaces') return [{ id: 'w1', owner: 'sg', name: 'phantom-looper-e2e', displayName: 'phantom-looper-e2e' }];
    if (path.split('?')[0] === '/sessions') return { sessions: sessions, total: (sessions).length };
    if (path === '/sessions/s9') return sessions[0];
    if (path === '/sessions/s9/lock') return { locked: true };
    if (path === '/sessions/s9/transcript') return { data: null };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const seen: string[] = [];
  const { stdin, lastFrame } = app({ api: settingsApi({}, [], api), newTools: async () => ({}), onSession: (s) => seen.push(`${s.id} ${s.branch}`) });
  await sleep(50);
  stdin.write('/resume'); await sleep(40);
  stdin.write(ENTER); await sleep(140);          // submit -> the list opens
  const listed = strip(lastFrame() ?? '');
  assert.match(listed, /resume/);
  assert.match(listed, /phantom-looper-e2e/);
  assert.ok(!/type a message/.test(listed), 'the list replaces the prompt');
  stdin.write(ENTER); await sleep(140);          // pick it
  assert.deepEqual(seen, ['s9 agent/s9'], 'reopened in the same window');
  assert.match(strip(lastFrame() ?? ''), /type a message/, 'and the prompt comes back');
});

test('/resume marks a session held elsewhere, says what it was about, and [d] duplicates it', async () => {
  const calls: string[] = [];
  const sessions = [
    { id: 's9', workspaceId: 'w1', branch: 'agent/s9', status: 'active', lastUsedAt: '2026-08-21T10:00:00Z',
      locked: true, lockedBy: 'other-window', lockedLabel: 'laptop', lastUserMessage: 'ship the release' },
  ];
  const api = async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    if (path === '/workspaces') return [{ id: 'w1', owner: 'sg', name: 'widgets' }];
    if (path.split('?')[0] === '/sessions') return { sessions: sessions, total: (sessions).length };
    if (path === '/sessions/s9/duplicate') return { id: 's10', branch: 'agent/s10', workspaceId: 'w1', status: 'active' };
    if (path === '/sessions/s10') return { id: 's10', branch: 'agent/s10', workspaceId: 'w1', status: 'active' };
    if (path === '/sessions/s10/lock') return { locked: true };
    if (path === '/sessions/s10/transcript') return { data: null };
    return {};
  };
  const seen: string[] = [];
  const { stdin, lastFrame } = app({ api: settingsApi({}, [], api), newTools: async () => ({}), clientId: 'me', onSession: (s) => seen.push(`${s.id} ${s.branch}`) });
  await sleep(50);
  stdin.write('/resume'); await sleep(40);
  stdin.write(ENTER); await sleep(140);
  const listed = strip(lastFrame() ?? '');
  assert.match(listed, /"ship the release"/, 'the server transcript says what it was about');
  assert.match(listed, /\[d\] duplicate · \[x\] close · \[t\] trash/, 'the keys are offered');
  stdin.write('d'); await sleep(200);
  assert.ok(calls.includes('POST /sessions/s9/duplicate'), '[d] duplicates on the server');
  assert.deepEqual(seen, ['s10 agent/s10'], 'and the copy opens here');
});

test('/resume refreshes itself while open, on pollMs; closing stops the clock', async () => {
  let listReads = 0;
  let sessions: SessionInfo[] = [
    { id: 's9', workspaceId: 'w1', branch: 'agent/s9', status: 'active', lastUsedAt: '2026-08-21T10:00:00Z',
      lastUserMessage: 'start the work' },
  ];
  const api = async (method: string, path: string) => {
    if (path === '/workspaces') return [{ id: 'w1', owner: 'sg', name: 'widgets' }];
    if (path.split('?')[0] === '/sessions') { listReads++; return { sessions, total: sessions.length }; }
    return {};
  };
  const { stdin, lastFrame } = app({ api: settingsApi({}, [], api), clientId: 'me', pollMs: 120 });
  await sleep(50);
  stdin.write('/resume'); await sleep(40);
  stdin.write(ENTER); await sleep(140);
  assert.match(strip(lastFrame() ?? ''), /agent\/s9/);
  const opened = listReads;
  // The server moves while the list sits open: another machine takes the
  // session and its last message lands. No key is pressed here.
  sessions = [{ ...sessions[0], locked: true, lockedBy: 'other', lockedLabel: 'laptop',
    lastUserMessage: 'ship the release' }];
  await sleep(320);                              // a couple of pollMs ticks
  assert.ok(listReads > opened, 'the open list re-reads the server on its own');
  assert.match(strip(lastFrame() ?? ''), /"ship the release"/, 'the new state lands without a keypress');
  stdin.write(ESC); await sleep(60);
  const closed = listReads;
  await sleep(320);
  assert.equal(listReads, closed, 'closed, the refresh stops');
});

test('/resume lazy-loads: one page at open, the next as the cursor nears the bottom, every session reachable', async () => {
  // 35 sessions, newest first — more than one PICKER_PAGE (30), so the tail
  // exists only behind a second fetch.
  const all = Array.from({ length: 35 }, (_, i) => ({
    id: `s${i}`, workspaceId: 'w1', branch: `agent/s${i}`, status: 'active',
    lastUsedAt: new Date(Date.UTC(2026, 7, 21, 10, 0, 0) - i * 60_000).toISOString(),
    lastUserMessage: `task ${i}`,
  }));
  const listCalls: string[] = [];
  const api = async (method: string, path: string) => {
    if (path === '/workspaces') return [{ id: 'w1', owner: 'sg', name: 'widgets' }];
    if (path.split('?')[0] === '/sessions') {
      listCalls.push(path);
      const q = new URLSearchParams(path.split('?')[1] ?? '');
      const limit = Number(q.get('limit') ?? all.length);
      const beforeId = q.get('before_id');
      const start = beforeId ? all.findIndex((s) => s.id === beforeId) + 1 : 0;
      return { sessions: all.slice(start, start + limit), total: all.length };
    }
    return {};
  };
  const { stdin, lastFrame } = app({ api: settingsApi({}, [], api), clientId: 'me' });
  await sleep(50);
  stdin.write('/resume'); await sleep(40);
  stdin.write(ENTER); await sleep(140);
  assert.match(listCalls[0], /limit=30/, 'the open fetches ONE page, never the whole list');
  assert.ok(!listCalls[0].includes('git=true'), 'the opening fetch never waits on git');
  // The open is TWO fetches by design: the instant plain page, then the
  // git-inclusive refresh right behind it filling the work column in place.
  assert.equal(listCalls.length, 2);
  assert.match(listCalls[1], /git=true/, 'the follow-up carries the work column');
  assert.match(strip(lastFrame() ?? ''), /"task 0"/, 'newest on top');
  // Header + 30 rows = 31 choices; the near-end zone starts NEAR_END (10)
  // from the bottom, so the 20th step down asks for the next page.
  for (let i = 0; i < 20; i++) stdin.write(DOWN);
  await sleep(200);
  const more = listCalls.find((c) => c.includes('before_id'));
  assert.ok(more, 'nearing the bottom fetched the next page');
  assert.match(more!, /before_id=s29/, 'the cursor is the last loaded row');
  // The tail is now loaded: the bottom of the list is session 34.
  for (let i = 0; i < 14; i++) stdin.write(DOWN);
  await sleep(200);
  assert.match(strip(lastFrame() ?? ''), /"task 34"/, 'the oldest session is reachable');
  // The short page (5 < 30) marked the end: sitting at the bottom asks again for nothing.
  const asked = listCalls.length;
  stdin.write(UP); stdin.write(DOWN); await sleep(100);
  assert.equal(listCalls.length, asked, 'the end is the end — no re-fetch at the bottom');
});

test('[t] trashes a session; unpushed work refuses once and the same [t] again forces', async () => {
  const calls: string[] = [];
  let sessions = [
    { id: 's9', workspaceId: 'w1', branch: 'agent/s9', status: 'active', lastUsedAt: '2026-08-21T10:00:00Z',
      lastUserMessage: 'start the work' },
  ];
  const api = async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    if (path === '/workspaces') return [{ id: 'w1', owner: 'sg', name: 'widgets' }];
    if (path.split('?')[0] === '/sessions') return { sessions: sessions, total: (sessions).length };
    if (path === '/sessions/s9?purge=true') throw new Error('DELETE: {"code":"unpushed_work","message":"session holds dirty work"}');
    if (path === '/sessions/s9?purge=true&force=true') { sessions = []; return { purged: 's9' }; }
    return {};
  };
  const { stdin, lastFrame } = app({ api: settingsApi({}, [], api), newTools: async () => ({}) });
  await sleep(50);
  stdin.write('/resume'); await sleep(40);
  stdin.write(ENTER); await sleep(140);
  stdin.write('t'); await sleep(140);
  assert.ok(calls.includes('DELETE /sessions/s9?purge=true'), 'the first [t] tries without force');
  assert.match(strip(lastFrame() ?? ''), /unpushed work — \[t\] again to discard it/,
    'the refusal speaks on the picker, not into the covered conversation');
  stdin.write('t'); await sleep(140);
  assert.ok(calls.includes('DELETE /sessions/s9?purge=true&force=true'), 'the second [t] discards');
  const after = strip(lastFrame() ?? '');
  assert.doesNotMatch(after, /start the work/, 'the list refreshed in place — the trashed row is gone');
  assert.match(after, /•.*agent\/s1|loaded in this window/, 'what is left is the session open here');
});

test('reopening the session you are already in says so instead of churning', async () => {
  const api = async (method: string, path: string) => {
    if (path === '/workspaces') return [{ id: 'w1', owner: 'sg', name: 'x', displayName: 'x' }];
    if (path.split('?')[0] === '/sessions') return { sessions: [{ id: 's1', workspaceId: 'w1', branch: 'agent/s1', status: 'active', lastUsedAt: '2026-08-21T10:00:00Z' }], total: ([{ id: 's1', workspaceId: 'w1', branch: 'agent/s1', status: 'active', lastUsedAt: '2026-08-21T10:00:00Z' }]).length };
    return { id: 's1', branch: 'agent/s1', workspaceId: 'w1', status: 'active' };
  };
  const { stdin, frames } = app({ api, newTools: async () => ({}) });
  await sleep(50);
  stdin.write('/resume'); await sleep(40);
  stdin.write(ENTER); await sleep(140);
  stdin.write(ENTER); await sleep(140);
  assert.match(strip(frames.join('\n')), /already here/);
});

test('a reaped session is RESTARTED on its own branch, not opened empty', async () => {
  // Destroying a session deletes its files, not the session: the row keeps its
  // id and its branch, so reopening it asks the server for that id back.
  const dead = { id: 'sD', workspaceId: 'w1', branch: 'agent/sD', status: 'destroyed', lastUsedAt: '2026-08-14T10:00:00Z',
    lastUserMessage: 'old work' };
  const calls: Array<[string, string, unknown]> = [];
  const api = async (m: string, path: string, body?: unknown) => {
    calls.push([m, path, body]);
    if (path === '/workspaces') return [{ id: 'w1', owner: 'sg', name: 'x', displayName: 'x' }];
    if (path.split('?')[0] === '/sessions' && m === 'GET') return { sessions: [dead], total: ([dead]).length };
    if (path.split('?')[0] === '/sessions' && m === 'POST') return { ...dead, status: 'active' };
    return dead;
  };
  const { stdin, frames } = app({ api, newTools: async () => ({}) });
  await sleep(50);
  stdin.write('/resume'); await sleep(40);
  stdin.write(ENTER); await sleep(140);
  stdin.write(ENTER); await sleep(200);
  assert.deepEqual(
    calls.find(([m, p]) => m === 'POST' && p === '/sessions')?.[2],
    { workspace_id: 'w1', id: 'sD' },
    'reopening a destroyed session restarts it by id',
  );
  assert.match(strip(frames.join('\n')), /agent\/sD/);
});

// ── tab completion ──────────────────────────────────────────────────────────
test('complete(): one match finishes it, several go as far as they agree', async () => {
  const { complete } = await import('./commands.js');
  assert.equal(complete('/set'), '/settings ', 'unique prefix completes and adds a space');
  assert.equal(complete('/se'), '/se', 'a shared prefix goes only as far as the names agree');
  // /w is workspace or wake: as far as they agree is the w already typed — no-op.
  assert.equal(complete('/w'), '/w');
  assert.equal(complete('/wo'), '/workspace ');
  assert.equal(complete('/wa'), '/wake ');
  // /m is model or mic: same rule.
  assert.equal(complete('/m'), '/m');
  assert.equal(complete('/mo'), '/model ');
  // Ambiguous: nothing is invented.
  assert.equal(complete('/zzz'), '/zzz', 'no match is a no-op, never a guess');
  assert.equal(complete('/'), '/', 'the bare slash cannot pick for you');
  // An explicit index wins — that is the arrow-key path.
  assert.equal(complete('/', 1), `/${COMMANDS[1].name} `);
});

test('tab completes the typed command in the prompt', async () => {
  const { stdin, lastFrame } = app();
  await sleep(50);
  stdin.write('/set'); await sleep(60);
  assert.match(strip(lastFrame() ?? ''), /\/settings/, 'the match is listed');
  stdin.write('\t'); await sleep(80);
  assert.match(strip(lastFrame() ?? ''), /> \/settings/, 'and tab puts it in the prompt');
});

test('arrows move the highlight and tab takes the highlighted one', async () => {
  const { stdin, lastFrame } = app();
  await sleep(50);
  stdin.write('/'); await sleep(60);
  const first = strip(lastFrame() ?? '');
  assert.match(first, /❯ \/new/, 'the first command starts highlighted');
  stdin.write('\x1b[B'); await sleep(60);          // down
  assert.match(strip(lastFrame() ?? ''), /❯ \/resume/);
  stdin.write('\t'); await sleep(80);
  assert.match(strip(lastFrame() ?? ''), /> \/resume/);
});

test('a completed command runs on enter', async () => {
  const { stdin, frames } = app();
  await sleep(50);
  stdin.write('/hel'); await sleep(50);
  stdin.write('\t'); await sleep(70);
  stdin.write(ENTER); await sleep(90);
  assert.match(strip(frames.join('\n')), /\/resume\s+reopen an earlier session/,
    'trailing space and all, /help still parses');
});

test('tab does nothing to ordinary text', async () => {
  const { stdin, lastFrame } = app();
  await sleep(50);
  stdin.write('fix the bug'); await sleep(50);
  stdin.write('\t'); await sleep(70);
  const f = strip(lastFrame() ?? '');
  assert.match(f, /> fix the bug/, 'left alone');
  assert.ok(!/\[tab\] complete/.test(f), 'and no command list appears');
});

// ── adding a workspace ──────────────────────────────────────────────────────
import { NewWorkspace } from './components/NewWorkspace.js';

test('the workspace list always offers a way to add one', () => {
  const rows = workspaceChoices(W);
  assert.equal(rows[rows.length - 1].label, 'add a workspace…');
  // And an empty install leads with it instead of a dead end.
  const empty = workspaceChoices([]);
  assert.equal(empty.length, 1);
  assert.deepEqual(empty[0].value, { kind: 'add' });
  assert.match(String(empty[0].detail), /nothing here yet/);
});

/** What GET /github/repos answers; every other call is a surprise. */
const ghApi = (repos: unknown[] | Error) => async (method: string, path: string) => {
  if (method === 'GET' && path === '/github/repos') {
    if (repos instanceof Error) throw repos;
    return repos;
  }
  throw new Error(`unexpected ${method} ${path}`);
};
const REPOS = [
  { owner: 'sg', name: 'thing', private: true, defaultBranch: 'main',
    pushedAt: new Date(NOW - 2 * 3600e3).toISOString(), added: false },
  { owner: 'acme', name: 'widgets', private: false, defaultBranch: 'develop',
    pushedAt: new Date(NOW - 3 * 86400e3).toISOString(), added: true },
];

test('adding an existing repo lists what the token can see; typing filters, enter adds the highlighted one', async () => {
  let got: unknown;
  const { stdin, lastFrame } = render(
    <NewWorkspace api={ghApi(REPOS)} now={NOW} onSubmit={(r) => { got = r; }} onCancel={() => {}} />);
  await sleep(50);
  assert.match(strip(lastFrame() ?? ''), /an existing repo/);
  stdin.write(ENTER); await sleep(120);         // "an existing repo" -> the list
  let f = strip(lastFrame() ?? '');
  assert.match(f, /sg\/thing\s+private\s+pushed 2h/, 'each row: repo · visibility · last push');
  assert.match(f, /acme\/widgets\s+public\s+already a workspace/, 'a registered one says so instead');
  assert.match(f, /newest push first/);
  stdin.write('thi'); await sleep(80);          // filter as you type
  f = strip(lastFrame() ?? '');
  assert.match(f, /sg\/thing/);
  assert.ok(!/acme\/widgets/.test(f), 'the filter narrows the list');
  assert.match(f, /add “thi”/, 'and whatever was typed is a row of its own');
  stdin.write(ENTER); await sleep(80);          // the highlighted row is sg/thing
  assert.deepEqual(got, { url: 'sg/thing' }, 'owner/name, no create flag — nothing is made on GitHub');
});

test('a repo that is already a workspace is shown but never added twice', async () => {
  let calls = 0;
  const { stdin, lastFrame } = render(
    <NewWorkspace api={ghApi(REPOS)} onSubmit={() => { calls++; }} onCancel={() => {}} />);
  await sleep(50);
  stdin.write(ENTER); await sleep(120);
  stdin.write(DOWN); await sleep(40);           // onto acme/widgets
  stdin.write(ENTER); await sleep(80);
  assert.equal(calls, 0, 'no submit');
  assert.match(strip(lastFrame() ?? ''), /acme\/widgets is already a workspace here/);
});

test('a repo the token cannot list is typed into the same field', async () => {
  let got: unknown;
  const { stdin, lastFrame } = render(
    <NewWorkspace api={ghApi(REPOS)} onSubmit={(r) => { got = r; }} onCancel={() => {}} />);
  await sleep(50);
  stdin.write(ENTER); await sleep(120);
  stdin.write('https://github.com/else/where'); await sleep(80);
  const f = strip(lastFrame() ?? '');
  assert.match(f, /> https:\/\/github\.com\/else\/where/, 'the field holds the whole value');
  // The row truncates at the label cap (SelectList's law); the field above is
  // where the full text lives.
  assert.match(f, /❯ add “https:\/\/github\.com\/else/);
  assert.ok(!/sg\/thing|acme\/widgets/.test(f), 'nothing listed matches, so the typed row stands alone');
  stdin.write(ENTER); await sleep(80);          // the only row left is the typed one
  assert.deepEqual(got, { url: 'https://github.com/else/where' });
});

test('with no GitHub token the existing-repo path falls back to the URL field and says why', async () => {
  let got: unknown;
  const noToken = Object.assign(new Error('no github_token stored'), { code: 'not_set' });
  const { stdin, lastFrame } = render(
    <NewWorkspace api={ghApi(noToken)} onSubmit={(r) => { got = r; }} onCancel={() => {}} />);
  await sleep(50);
  stdin.write(ENTER); await sleep(120);
  const f = strip(lastFrame() ?? '');
  assert.match(f, /no GitHub token in \/keys — type the repo instead/, 'the reason, and the way out');
  assert.match(f, /github\.com\/owner\/name/, 'the URL field');
  stdin.write('https://github.com/sg/thing'); await sleep(50);
  stdin.write(ENTER); await sleep(80);
  assert.deepEqual(got, { url: 'https://github.com/sg/thing' });
});

test('creating a new repo takes just a name, asks visibility, defaults private', async () => {
  let got: unknown;
  const { stdin, lastFrame } = render(
    <NewWorkspace api={ghApi([])} onSubmit={(r) => { got = r; }} onCancel={() => {}} />);
  await sleep(50);
  stdin.write(DOWN); await sleep(40);
  stdin.write(ENTER); await sleep(70);          // "a new repo"
  assert.match(strip(lastFrame() ?? ''), /under your account/, 'a name is enough — no URL asked for');
  stdin.write('brand-new'); await sleep(50);
  stdin.write(ENTER); await sleep(80);
  const f = strip(lastFrame() ?? '');
  assert.match(f, /private/);
  assert.match(f, /recommended/, 'private is the recommended default');
  stdin.write(ENTER); await sleep(80);
  assert.deepEqual(got, { url: 'brand-new', create: true, private: true },
    'the server resolves the owner from the token');
});

test('enter with nothing listed and nothing typed adds nothing', async () => {
  let calls = 0;
  const { stdin, lastFrame } = render(<NewWorkspace api={ghApi([])} onSubmit={() => { calls++; }} onCancel={() => {}} />);
  await sleep(50);
  stdin.write(ENTER); await sleep(120);
  assert.match(strip(lastFrame() ?? ''), /sees no repos — type one/);
  stdin.write(ENTER); await sleep(70);          // enter on an empty list
  assert.equal(calls, 0);
});

test('a server error keeps the form up, in the server’s own words', async () => {
  const { lastFrame } = render(
    <NewWorkspace api={ghApi([])} onSubmit={() => {}} onCancel={() => {}}
      error='{"code":"already_exists","message":"sg/thing already exists on GitHub"}' />);
  await sleep(50);
  assert.match(strip(lastFrame() ?? ''), /already exists on GitHub/);
});

test('a rejected submit hands the form back with the typed value — never a dead spinner', async () => {
  const api = ghApi([]);
  const { stdin, lastFrame, rerender } = render(
    <NewWorkspace api={api} onSubmit={() => {}} onCancel={() => {}} />);
  await sleep(50);
  stdin.write(ENTER); await sleep(120);         // "an existing repo" -> the (empty) list
  stdin.write('sg/thing'); await sleep(50);
  stdin.write(ENTER); await sleep(80);          // submit the typed row → the working screen
  assert.match(strip(lastFrame() ?? ''), /working…/);
  // The server rejects; App re-renders the SAME mounted form with the error.
  rerender(<NewWorkspace api={api} onSubmit={() => {}} onCancel={() => {}}
    error='{"code":"already_exists","message":"sg/thing already exists"}' />);
  await sleep(50);
  const f = strip(lastFrame() ?? '');
  assert.ok(!/working…/.test(f), 'the spinner is gone');
  assert.match(f, /sg\/thing already exists/, 'the server’s words are shown');
  assert.match(f, /> sg\/thing/, 'the typed value is back for correction');
});

test('/workspace can add one and drops you into a session in it', async () => {
  const calls: string[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    calls.push(`${method} ${path}`);
    if (path === '/workspaces' && method === 'GET') return [];
    if (path === '/github/repos') return [];
    if (path.split('?')[0] === '/sessions' && method === 'GET') return { sessions: [], total: ([]).length };
    if (path === '/workspaces' && method === 'POST') {
      assert.deepEqual(body, { url: 'https://github.com/sg/fresh' });
      return { id: 'wNEW', owner: 'sg', name: 'fresh' };
    }
    if (path.split('?')[0] === '/sessions' && method === 'POST') {
      assert.deepEqual(body, { workspace_id: 'wNEW' });
      return { id: 'sNEW', branch: 'agent/sNEW', workspaceId: 'wNEW', status: 'active',
        skills: [], agent_git_credentials: false };
    }
    if (path === '/sessions/sNEW/lock') return { locked: true };
    if (path === '/sessions/sNEW/transcript') return { data: null };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const seen: string[] = [];
  const { stdin, frames } = app({ api: settingsApi({}, [], api), newTools: async () => ({}), onSession: (s) => seen.push(`${s.id} ${s.branch}`) });
  await sleep(50);
  stdin.write('/workspace'); await sleep(40);
  stdin.write(ENTER); await sleep(140);        // the (empty) list -> only "add…"
  stdin.write(ENTER); await sleep(90);         // pick add
  stdin.write(ENTER); await sleep(140);        // "an existing repo" -> the (empty) repo list
  stdin.write('https://github.com/sg/fresh'); await sleep(50);
  stdin.write(ENTER); await sleep(160);        // the typed row
  const all = strip(frames.join('\n'));
  assert.match(all, /workspace sg\/fresh added/);
  assert.deepEqual(seen, ['sNEW agent/sNEW'], 'and you land in it');
  assert.ok(calls.includes('POST /workspaces') && calls.includes('POST /sessions'));
});

test('tab moves the cursor to the end, not just the text', async () => {
  const { stdin, lastFrame } = app();
  await sleep(50);
  stdin.write('/set'); await sleep(50);
  stdin.write('\t'); await sleep(90);
  // Typing now must append. If the cursor stayed at offset 3 (where "/se"
  // ended) this lands inside the word instead: "/sexttings ".
  stdin.write('x'); await sleep(70);
  const f = strip(lastFrame() ?? '');
  assert.match(f, /> \/settings x/, 'input continues at the end');
  assert.ok(!/\/sex/.test(f), 'and not in the middle of the completed word');
});

test('menus leave a blank line under them', async () => {
  const { stdin, lastFrame } = app();
  await sleep(50);
  stdin.write('/settings'); await sleep(40);
  stdin.write(ENTER); await sleep(110);
  const lines = strip(lastFrame() ?? '').split('\n');
  assert.equal(lines[lines.length - 1].trim(), '', 'the menu does not butt against the shell');
});

test('the command list leaves a blank line under it too', async () => {
  const { stdin, lastFrame } = app();
  await sleep(50);
  stdin.write('/'); await sleep(70);
  const lines = strip(lastFrame() ?? '').split('\n');
  const listEnd = lines.findIndex((l) => l.includes('[tab] complete'));
  assert.ok(listEnd > 0, 'the hint line is there');
  assert.equal(lines[listEnd + 1].trim(), '', 'and a blank line separates it from the prompt');
});

test('the command list scrolls to keep the highlighted row on screen', async () => {
  // More commands than the menu shows at once: the window follows the cursor
  // and says how many lie beyond it, so ↓ never lands on an unseen row and
  // every command is reachable from a bare "/".
  const { stdin, lastFrame } = app();
  await sleep(50);
  stdin.write('/'); await sleep(70);
  const shown = () => strip(lastFrame() ?? '').split('\n').filter((l) => /^\s*(❯ )?\//.test(l)).length;
  assert.ok(COMMANDS.length > 8, 'the table is longer than the window (else this test is moot)');
  assert.equal(shown(), 8, 'eight rows at first');
  assert.match(strip(lastFrame() ?? ''), new RegExp(`↓ ${COMMANDS.length - 8} more`), 'and a count of what is below');
  for (let i = 0; i < COMMANDS.length - 1; i++) {
    stdin.write(DOWN); await sleep(40);
    const f = strip(lastFrame() ?? '');
    assert.match(f, new RegExp(`❯ /${COMMANDS[i + 1].name}\\b`), `row ${i + 1} (/${COMMANDS[i + 1].name}) is on screen when chosen`);
    assert.equal(shown(), 8, 'still eight rows');
  }
  const last = strip(lastFrame() ?? '');
  assert.match(last, new RegExp(`↑ ${COMMANDS.length - 8} more`), 'at the bottom, the count is what lies above');
  assert.ok(!/↓ \d+ more/.test(last), 'and nothing below');
  stdin.write(DOWN); await sleep(40);
  assert.match(strip(lastFrame() ?? ''), /❯ \/new\b/, 'one more ↓ wraps to the top');
});

test('the command menu keeps one height while it filters — the pane above must not move', async () => {
  // The menu sits under a bottom-anchored pane: a box that resized as the
  // list narrowed shifted the whole conversation on every keystroke, and the
  // near-full repaint read as flicker on terminals without synchronized
  // output. The box reserves its full height and pads with blank rows, so
  // every keystroke leaves the rows above it exactly where they were.
  const { stdin, lastFrame } = app();
  await sleep(50);
  const rows = () => strip(lastFrame() ?? '').split('\n');
  const hintRow = () => rows().findIndex((l) => l.includes('[tab] complete'));
  stdin.write('/'); await sleep(70);
  const atSlash = hintRow();
  const height = rows().length;
  assert.ok(atSlash > 0, 'the menu is open');
  stdin.write('s'); await sleep(70);
  assert.equal(hintRow(), atSlash, 'three matches: the hint row has not moved');
  assert.equal(rows().length, height, 'and the frame is the same height');
  stdin.write('e'); await sleep(70);
  assert.equal(hintRow(), atSlash, 'one match: still not moved');
  assert.equal(rows().length, height);
});

test('every menu title sits alone: one blank line above it and one below', async () => {
  for (const [cmd, title] of [['/settings', 'settings'], ['/model', 'model'],
    ['/resume', 'resume'], ['/workspace', 'workspace']] as const) {
    const api = settingsApi({}, [], async (_m: string, path: string) => path === '/workspaces'
      ? [{ id: 'w1', owner: 'sg', name: 'x', displayName: 'x' }]
      : path.split('?')[0] === '/sessions' ? { sessions: [], total: 0 } : {});
    const { stdin, lastFrame } = app({ api, newTools: async () => ({}) });
    await sleep(50);
    stdin.write(cmd); await sleep(40);
    stdin.write(ENTER); await sleep(140);
    const lines = strip(lastFrame() ?? '').split('\n');
    const at = lines.findIndex((l) => l.trim() === title || l.trim().startsWith(`${title} `));
    assert.ok(at > 0, `${cmd} rendered its title`);
    // Above the title is the conversation pane, which may be all blank rows
    // in a fresh session — the margin is Screen's, the rows above are the
    // pane's, so only the line directly above is asserted.
    assert.equal(lines[at - 1].trim(), '', `${cmd}: blank line above`);
    assert.equal(lines[at + 1].trim(), '', `${cmd}: blank line below, before the list`);
    assert.notEqual(lines[at + 2]?.trim(), '', `${cmd}: the list starts right after`);
  }
});

test('the cursor starts on the first real row, never on a group heading', async () => {
  const { stdin, lastFrame } = app({ configPath: cfgFile() });
  await sleep(50);
  stdin.write('/model'); await sleep(50);
  stdin.write(ENTER); await sleep(140);
  const list = strip(lastFrame() ?? '');
  assert.match(list, /❯ provider/, 'not the `model` heading above it');
  stdin.write(ENTER); await sleep(140);          // enter opens it, first try
  assert.match(strip(lastFrame() ?? ''), /openai-compatible/,
    'the editor opened without arrowing away and back first');
});

test('SelectList normalises a stale index instead of drawing a dead list', async () => {
  const { SelectList } = await import('./components/SelectList.js');
  function Swap() {
    const [second, setSecond] = useState(false);
    useInput((_c, k) => { if (k.rightArrow) setSecond(true); });
    // Same element type in the same position: React keeps the child's state.
    return <SelectList
      choices={second
        ? [{ value: 'h', label: 'group', heading: true }, { value: 'x', label: 'real row' }]
        : [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }]}
      onSelect={() => {}} />;
  }
  const { stdin, lastFrame } = render(<Swap />);
  await sleep(50);
  assert.match(strip(lastFrame() ?? ''), /❯ a/);
  stdin.write('\x1b[C'); await sleep(70);         // right arrow -> swap the choices
  const f = strip(lastFrame() ?? '');
  assert.match(f, /❯ real row/, 'index 0 is now a heading, so the cursor moves off it');
  assert.ok(!/❯ group/.test(f), 'a heading is never the cursor');
});

test('enter runs the highlighted command, not the half-typed text', async () => {
  // `/` alone: the list is showing with the first row highlighted, so enter
  // takes it. Previously this submitted "/" and answered "type a command name".
  const { stdin, frames, lastFrame } = app();
  await sleep(50);
  stdin.write('/'); await sleep(60);
  assert.match(strip(lastFrame() ?? ''), /❯ \/new/);
  stdin.write(DOWN); await sleep(50);            // -> /resume
  stdin.write(DOWN); await sleep(50);            // -> /workspace
  stdin.write(DOWN); await sleep(50);            // -> /kanban
  stdin.write(DOWN); await sleep(50);            // -> /tasks
  stdin.write(DOWN); await sleep(50);            // -> /plan
  stdin.write(DOWN); await sleep(50);            // -> /auto-push
  stdin.write(DOWN); await sleep(50);            // -> /model
  assert.match(strip(lastFrame() ?? ''), /❯ \/model/);
  stdin.write(ENTER); await sleep(140);
  const f = strip(lastFrame() ?? '');
  assert.match(f, /❯ provider/, 'the highlighted command ran');
  assert.ok(!/type a command name/.test(strip(frames.join('\n'))),
    'and no "type a command name" complaint');
});

test('a bare / plus enter opens the first command rather than erroring', async () => {
  const api = async (_m: string, path: string) => path === '/workspaces'
    ? [{ id: 'w1', owner: 'sg', name: 'x', displayName: 'x' }] : {};
  const { stdin, frames } = app({ api, newTools: async () => ({}) });
  await sleep(50);
  stdin.write('/'); await sleep(60);
  stdin.write(ENTER); await sleep(140);          // /new is first
  const all = strip(frames.join('\n'));
  assert.ok(!/type a command name/.test(all));
  assert.match(all, /session /, '/new ran');
});

test('a typed-out command still runs, and a bad one still says so', async () => {
  const { stdin, frames } = app();
  await sleep(50);
  stdin.write('/help'); await sleep(50);
  stdin.write(ENTER); await sleep(110);
  assert.match(strip(frames.join('\n')), /\/new\s+new session in this workspace/);
  stdin.write('/zzzz'); await sleep(50);
  stdin.write(ENTER); await sleep(110);
  assert.match(strip(frames.join('\n')), /unknown command \/zzzz/);
});

test('a single-group screen drops the heading that would repeat its title', async () => {
  const cfg = cfgFile();
  const rows = localRows(localValues(cfg, {}) as Record<ConfigKey, ConfigValue>, false, ['model']);
  assert.ok(!rows.some((r) => r.heading), 'no "model" heading under a "model" title');
  assert.equal(rows[0].label, 'provider');
  // Both groups together still get headings, because now they distinguish.
  const both = localRows(localValues(cfg, {}) as Record<ConfigKey, ConfigValue>, false, ['model', 'server']);
  assert.ok(both.some((r) => r.heading && r.label === 'server'));
});

test('the "a" shortcut is only advertised when there is something to reveal', async () => {
  // The keys live on the server now, so what is hidden is a matter of what the
  // server holds — not of what is in this machine's file.
  const bare = app({ configPath: cfgFile() });
  await sleep(50);
  bare.stdin.write('/model'); await sleep(40);
  bare.stdin.write(ENTER); await sleep(130);
  assert.ok(!/\[a\] all keys/.test(strip(bare.lastFrame() ?? '')), 'no other keys stored, so no offer');

  const withKey = app({ configPath: cfgFile(),
    api: settingsApi({ provider: 'anthropic', openai_api_key: 'sk-x' }) });
  await sleep(50);
  withKey.stdin.write('/model'); await sleep(40);
  withKey.stdin.write(ENTER); await sleep(130);
  assert.match(strip(withKey.lastFrame() ?? ''), /\[a\] all keys/);
});

// ── one workspace ───────────────────────────────────────────────────────────
import { WorkspaceSettings } from './components/WorkspaceSettings.js';
import { Keys } from './components/Keys.js';

const WS_ROW = { id: 'w1', owner: 'sg', name: 'widgets', displayName: 'Widgets',
  baseBranch: 'main', branchPrefix: 'agent', hasCredential: false };

/** What GET /workspaces/:id's `settings` serves, built from the REAL server
 *  tables — a fixture with
 *  its own hand-written labels would be the very copy this screen exists to
 *  avoid, and would pass while the shipped names were nonsense. */
const eff = (key: string, value: unknown, source: string, overridable = true) => ({
  value, source, overridable,
  description: SRV_DESCRIPTIONS[key as keyof typeof SRV_DESCRIPTIONS],
  meta: SRV_META[key as keyof typeof SRV_META],
});
const EFFECTIVE = () => ({
  agent_git_credentials: eff('agent_git_credentials', false, 'default'),
  auto_push_on_archive: eff('auto_push_on_archive', false, 'default'),
  container_image: eff('container_image', 'img:1', 'workspace'),
  auto_push_fix_model: eff('auto_push_fix_model', 'claude-opus-5', 'default', false),
});

/** The row the cursor is on, without its marker — SelectList draws "❯ ". */
const cursorRow = (frame: string) =>
  (frame.split('\n').find((l) => l.includes('❯')) ?? '').replace(/.*❯\s*/, '').trim();

function wsApi(calls: string[], eff = EFFECTIVE()) {
  return async (method: string, path: string, body?: unknown) => {
    calls.push(`${method} ${path}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`);
    if (method === 'GET' && path === '/workspaces/w1') return { ...WS_ROW, settings: eff };
    return {};
  };
}

test('the workspace screen shows only what a workspace can differ on, and where each value came from', async () => {
  const calls: string[] = [];
  const { lastFrame } = render(
    <WorkspaceSettings api={wsApi(calls)} workspace={{ id: 'w1', owner: 'sg', name: 'widgets', displayName: 'Widgets' }}
      onClose={() => {}} />);
  await sleep(90);
  const f = strip(lastFrame() ?? '');
  assert.match(f, /auto-push on archive/, 'settings are named in words, not in database keys');
  assert.ok(!/conflict ai model/.test(f),
    'a global-only setting must not appear here — it cannot be set per workspace');
  // Two answers, not four: is this workspace different from the others?
  assert.match(f, /changed here/, 'a value set here says so');
  assert.match(f, /same as everywhere/, 'an inherited value says that instead');
  assert.match(f, /base branch\s+main/, 'the workspace-only fields are here too');
  assert.match(f, /github token\s+the shared one from \/keys/);
  // No group headings: each said what its rows already said, in a dim line
  // that looks like content. The rows name their own subject instead — never
  // "this workspace" or "it".
  assert.ok(!/about Widgets|settings · Widgets only|deleting cannot/.test(f),
    'the headings are gone, not reworded again');
  assert.match(f, /delete Widgets\s+cannot be undone/);
  // The token and the switch that hands it to the agent are one decision in two
  // parts, so they are adjacent and each names the other.
  const rows = f.split('\n').map((l) => l.trim());
  const token = rows.findIndex((l) => l.startsWith('github token'));
  assert.ok(token >= 0, 'the workspace PAT is a row of its own');
  assert.match(rows[token + 1], /^agent github access/, 'and the switch sits under it');
});

test('n on the /workspace list opens the add-workspace form from any row', async () => {
  const api = async (_m: string, path: string) => path === '/workspaces' ? W
    : path.split('?')[0] === '/sessions' ? { sessions: [], total: 0 } : [];
  const { stdin, lastFrame } = app({ api: settingsApi({}, [], api) });
  await sleep(50);
  stdin.write('/workspace'); await sleep(40);
  stdin.write(ENTER); await sleep(140);
  assert.match(strip(lastFrame() ?? ''), /\[n\] new workspace/, 'the key is in the help line');
  stdin.write('n'); await sleep(90);
  assert.match(strip(lastFrame() ?? ''), /an existing repo/, 'the add form is up');
});

test('d removes the workspace value only where there is one to remove', async () => {
  const calls: string[] = [];
  const { stdin, lastFrame } = render(
    <WorkspaceSettings api={wsApi(calls)} workspace={{ id: 'w1', owner: 'sg', name: 'widgets' }}
      onClose={() => {}} />);
  await sleep(90);
  calls.length = 0;

  // Walk to a row by name rather than by counting: the list is ordered
  // deliberately and a count silently tests whatever moved into that slot.
  const to = async (label: string) => {
    for (let i = 0; i < 20; i++) {
      if (cursorRow(strip(lastFrame() ?? '')).startsWith(label)) return;
      stdin.write(DOWN); await sleep(30);
    }
    throw new Error(`never reached "${label}"`);
  };

  // auto_push_on_archive is inherited: d has nothing to remove and must say so
  // rather than sending a write that looks like it did something.
  await to('auto-push on archive');
  stdin.write('d'); await sleep(80);
  assert.deepEqual(calls, [], 'no write for a row that is not set here');
  assert.match(strip(lastFrame() ?? ''), /not set here/);

  // container_image is set here: d clears it with an explicit null.
  await to('container image');
  stdin.write('d'); await sleep(120);
  assert.ok(calls.some((c) => c === 'PATCH /workspaces/w1 {"container_image":null}'),
    `null is what removes it — got ${JSON.stringify(calls)}`);
});

test('changing a setting on the workspace screen patches the workspace, never the server settings', async () => {
  const calls: string[] = [];
  const { stdin, lastFrame } = render(
    <WorkspaceSettings api={wsApi(calls)} workspace={{ id: 'w1', owner: 'sg', name: 'widgets' }}
      onClose={() => {}} />);
  await sleep(90);
  calls.length = 0;
  for (let i = 0; i < 20 && !cursorRow(strip(lastFrame() ?? '')).startsWith('auto-push on archive'); i++) {
    stdin.write(DOWN); await sleep(30);
  }
  stdin.write(ENTER); await sleep(80);      // open it -> the yes/no picker, cursor on "yes"
  stdin.write(ENTER); await sleep(120);
  assert.ok(calls.some((c) => c === 'PATCH /workspaces/w1 {"auto_push_on_archive":true}'),
    `expected a workspace patch, got ${JSON.stringify(calls)}`);
  assert.ok(!calls.some((c) => c.startsWith('PATCH /settings ') || c === 'PATCH /settings'), 'a workspace change must never go server-wide');
});

// ── keys ────────────────────────────────────────────────────────────────────
test('the keys screen says which are stored, never what they are', async () => {
  const calls: string[] = [];
  const api = async (method: string, path: string, body?: unknown) => {
    calls.push(`${method} ${path}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`);
    if (path.startsWith('/settings')) return { github_token: { value: 'ghp', secret: true } };
    return {};
  };
  const { stdin, lastFrame } = render(<Keys api={api} onClose={() => {}} />);
  await sleep(90);
  let f = strip(lastFrame() ?? '');
  assert.match(f, /github token\s+stored/);
  assert.match(f, /anthropic key\s+not set/);

  // Setting one: the value goes over the wire, never onto the screen.
  stdin.write(DOWN); await sleep(50);
  stdin.write(ENTER); await sleep(60);
  stdin.write('sk-secret-value'); await sleep(60);
  assert.ok(!strip(lastFrame() ?? '').includes('sk-secret-value'), 'a key is masked while typing');
  stdin.write(ENTER); await sleep(120);
  assert.ok(calls.some((c) => c === 'PATCH /settings {"anthropic_api_key":"sk-secret-value"}'),
    `expected a PATCH, got ${JSON.stringify(calls)}`);
});

test('an empty key is a change of mind, not a stored empty string', async () => {
  const calls: string[] = [];
  const api = async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    if (path === '/settings') return {};
    return {};
  };
  const { stdin } = render(<Keys api={api} onClose={() => {}} />);
  await sleep(90);
  calls.length = 0;
  stdin.write(ENTER); await sleep(60);      // open github token
  stdin.write(ENTER); await sleep(120);     // submit nothing
  assert.deepEqual(calls, [], 'nothing is written, and nothing is cleared either');
});

test('the server settings list marks the ones a single workspace can differ on', async () => {
  const api = async () => ({
    auto_push_on_archive: { value: false, source: 'default', description: 'What archiving a card does.',
      overridable: true, meta: { type: 'boolean' } },
    auto_push_fix_model: { value: 'claude-opus-5', source: 'default', description: 'Model for conflict resolution.',
      overridable: false, meta: { type: 'string' } },
  });
  const { lastFrame } = render(
    <Settings api={api} configPath={cfgFile()} startAt="api" onClose={() => {}} />);
  await sleep(90);
  const f = strip(lastFrame() ?? '');
  assert.match(f, /↯ auto push on archive/, 'overridable rows are marked');
  assert.ok(!/↯ auto push fix model/.test(f), 'global-only rows are not');
});

test('e on a workspace opens its settings; the list says the key is there', async () => {
  const api = async (method: string, path: string) => {
    if (path === '/workspaces') return [{ id: 'w1', owner: 'sg', name: 'widgets', displayName: 'Widgets' }];
    if (path.split('?')[0] === '/sessions') return { sessions: [], total: ([]).length };
    if (path === '/workspaces/w1') return { ...WS_ROW, settings: EFFECTIVE() };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const { stdin, lastFrame } = app({ api, newTools: async () => ({}) });
  await sleep(50);
  stdin.write('/workspace'); await sleep(40);
  stdin.write(ENTER); await sleep(140);
  assert.match(strip(lastFrame() ?? ''), /\[e\] edit workspace/,
    'the list spells out what the key does, and brackets it so a bare letter is not lost in a sentence');
  stdin.write('e'); await sleep(150);
  const f = strip(lastFrame() ?? '');
  assert.match(f, /sg\/widgets/, 'the workspace screen is open');
  assert.match(f, /auto-push on archive/);
});

// ── one source for what a setting is called and does ────────────────────────
import { human, labelFor } from './settingLabels.js';
import { META as SRV_META2 } from '../phantom-backend/settings.js';

test("a setting's name and text come from the server, not from a copy here", () => {
  // The TUI briefly kept its own friendlier names and help text. That is two
  // places to write down what a setting means, so this asserts there is one:
  // the label rides in `meta`, and the client only formats the value.
  const meta = SRV_META2.auto_push_on_archive as never;
  assert.equal(labelFor('auto_push_on_archive', meta), 'auto-push on archive',
    'the name the screen shows is the one the server sent');
  assert.equal(labelFor('made_up_key', undefined), 'made up key',
    'and an older server that sends none still gives a readable row');

  // Values, though, are formatted here — that is presentation, not meaning.
  assert.equal(human(true), 'yes');
  assert.equal(human(false), 'no');
  assert.equal(human(null), 'not set');
  assert.equal(human('full', SRV_META2.initial_history_depth as never), 'full');
  assert.equal(human(2_592_000_000, { type: 'number', unit: 'ms' }), '30d');
  assert.equal(human(300_000, { type: 'number', unit: 'ms' }), '5m');
  assert.equal(human(10_000, { type: 'number', unit: 'ms' }), '10s');
  assert.equal(human(1_048_576, { type: 'number', unit: 'bytes' }), '1 MB');
  assert.equal(human(2, { type: 'number', unit: 'count' }), '2');
});

test('every server setting ships a name and a description, so no screen invents one', () => {
  // TypeScript already forces an entry per setting; this checks they are
  // usable — an empty label or a description that is still API shorthand is
  // what pushed a second copy into the client last time.
  for (const [key, meta] of Object.entries(SRV_META2)) {
    assert.ok((meta as { label?: string }).label, `${key} has no label`);
    assert.ok(SRV_DESCRIPTIONS[key as keyof typeof SRV_DESCRIPTIONS], `${key} has no description`);
  }
});

// ── ctrl+c ──────────────────────────────────────────────────────────────────
const CTRL_C = '\x03';

test('ctrl+c works inside a menu, not only at the prompt', async () => {
  // The app runs with exitOnCtrlC false and handles the key itself, and its
  // handler is switched off while a menu owns the keyboard — which used to
  // leave every menu screen with no way out but esc.
  const api = async (m: string, p: string) => {
    if (p === '/settings') return { spare_clones: { value: 2, source: 'default',
      description: 'Warm clones.', meta: { type: 'number' } } };
    return {};
  };
  const { stdin, lastFrame } = app({ api });
  await sleep(50);
  stdin.write('/settings'); await sleep(40);
  stdin.write(ENTER); await sleep(120);
  assert.match(strip(lastFrame() ?? ''), /spare clones/, 'the menu is open');

  stdin.write(CTRL_C); await sleep(120);
  const f = strip(lastFrame() ?? '');
  assert.ok(!/spare clones/.test(f), 'the first press breaks out of the menu');
  assert.match(f, /press ctrl\+c again to quit/, 'and says what a second press does');
});

test('ctrl+c on a list does not fire the list\'s letter shortcuts', async () => {
  // Ink reports ctrl+c as the letter `c`. A list that forwards every character
  // to onKey would run the `c` shortcut on the way past — and ctrl+e on the
  // workspace list would open the editor.
  const seen: string[] = [];
  const { stdin } = render(
    <SelectList choices={[{ value: 'a', label: 'a row' }]} onSelect={() => {}} onKey={(ch) => seen.push(ch)} />);
  await sleep(40);
  stdin.write(CTRL_C); await sleep(40);
  stdin.write('\x05');                       // ctrl+e
  await sleep(40);
  assert.deepEqual(seen, [], 'a chord is not a shortcut');
  stdin.write('d'); await sleep(40);
  assert.deepEqual(seen, ['d'], 'a plain letter still is');
});

test('the live session id is reported outward, so the exit line names the one you are in', async () => {
  // index.tsx prints "npm run phantom-cli -- --resume <id>" on the way out. /new,
  // /resume and /workspace all switch session in place, so the id it started
  // with is not the one you quit from — it has to hear about the change.
  const seen: string[] = [];
  const api = async () => ({ id: 's2', branch: 'agent/s2', workspaceId: 'w1', status: 'active' });
  const { stdin } = app({ api, newTools: async () => ({}), onSession: (s) => seen.push(`${s.id} ${s.branch}`) });
  await sleep(50);
  stdin.write('/new'); await sleep(40);
  stdin.write(ENTER); await sleep(140);
  assert.deepEqual(seen, ['s2 agent/s2'], 'the new session, not the one the window opened on');
});

test('/resume hides the looper card sessions by default; [s] shows them', async () => {
  const sessions = [
    { id: 's9', workspaceId: 'w1', branch: 'agent/s9', status: 'active', lastUsedAt: '2026-08-21T10:00:00Z',
      lastUserMessage: 'start the work' },
    { id: 'sup1', workspaceId: 'w1', branch: 'agent/sup1', status: 'active',
      lastUsedAt: '2026-08-22T10:00:00Z', agent: 'supervisor', card: 7,
      lastUserMessage: 'Card 7 — column plan' },
  ];
  const api = async (method: string, path: string) => {
    if (path === '/workspaces') return [{ id: 'w1', owner: 'sg', name: 'widgets', displayName: 'widgets' }];
    if (path.split('?')[0] === '/sessions') return { sessions: sessions, total: (sessions).length };
    return {};
  };
  const { stdin, lastFrame } = app({ api: settingsApi({}, [], api), newTools: async () => ({}) });
  await sleep(50);
  stdin.write('/resume'); await sleep(40);
  stdin.write(ENTER); await sleep(140);
  let f = strip(lastFrame() ?? '');
  assert.match(f, /agent\/s9|widgets/, 'the human session is listed');
  assert.ok(!f.includes('sup1'), 'the supervised session is hidden by default');
  stdin.write('s'); await sleep(80);
  f = strip(lastFrame() ?? '');
  assert.ok(f.includes('widgets'), 'still the resume list');
  // The supervised row is now present (same workspace label, two rows).
  assert.ok((f.match(/widgets/g) ?? []).length >= 2, '[s] shows the looper session too');
});

test('a supervisor session opens as a read-only record: rounds on screen, typing refused', async () => {
  const supJsonl = [
    JSON.stringify({ type: 'session', agent: 'supervisor', provider: 'p', model: 'm', created_at: 'now', system_prompt: 'SUP' }),
    JSON.stringify({ role: 'user', content: 'Card 7 — column plan' }),
    JSON.stringify({ role: 'assistant', content: 'Decision: in_progress' }),
  ].join('\n');
  const sup = { id: 'sup1', workspaceId: 'w1', branch: 'agent/sup1', status: 'active',
    lastUsedAt: '2026-08-22T10:00:00Z', agent: 'supervisor', card: 7,
    lastUserMessage: 'Card 7 — column plan' };
  const api = async (method: string, path: string) => {
    if (path === '/workspaces') return [{ id: 'w1', owner: 'sg', name: 'widgets', displayName: 'widgets' }];
    if (path.split('?')[0] === '/sessions') return { sessions: [sup], total: ([sup]).length };
    if (path === '/sessions/sup1') return sup;
    if (path === '/sessions/sup1/lock') return { locked: true };
    if (path === '/sessions/sup1/transcript') return { data: supJsonl };
    throw new Error(`unexpected ${method} ${path}`);
  };
  const { stdin, lastFrame } = app({ api: settingsApi({}, [], api), newTools: async () => ({}) });
  await sleep(50);
  stdin.write('/resume'); await sleep(40);
  stdin.write(ENTER); await sleep(140);
  stdin.write('s'); await sleep(80);          // reveal the looper session
  stdin.write(ENTER); await sleep(200);       // open it
  let f = strip(lastFrame() ?? '');
  assert.match(f, /the supervisor's record · card 7 — read-only/, 'it says what it is');
  assert.match(f, /Decision: in_progress/, 'the rounds are on screen — its ONE transcript');
  stdin.write('hello there'); await sleep(40);
  stdin.write(ENTER); await sleep(120);
  f = strip(lastFrame() ?? '');
  assert.match(f, /read-only/, 'typing is refused with a note, never sent');
  assert.ok(!f.includes('hello there\n'), 'nothing was submitted into the record');
});

// ── /tasks — what's running in the session's container ──────────────────────
import { taskChoices, type TasksView } from './components/Tasks.js';

const liveTask = (over: Partial<TasksView['tasks'][0]> = {}) => ({
  sid: '142', command: 'npm run dev', cmd_id: 'c1', logs: '/commands/c1/logs',
  log_file: '/workspace/logs/c1.ndjson',
  started_at: '2026-08-31T10:58:00Z', elapsed: '01:41', pids: 3, ...over,
});
const emptyTasks = (container: TasksView['container'] = 'running'): TasksView =>
  ({ container, tasks: [], recent: [] });

test('taskChoices: live rows first, untracked hint, recent with exit codes, empty states', () => {
  const view: TasksView = {
    container: 'running',
    tasks: [liveTask(), liveTask({ sid: '250', command: 'sleep 302', cmd_id: null, logs: null,
      log_file: null, started_at: '2026-08-31T10:59:30Z', elapsed: '00:30', pids: 1 })],
    recent: [
      { cmd_id: 'c0', command: 'npm run build', status: 'exited', exit_code: 0,
        started_at: '2026-08-31T10:00:00Z', ended_at: '2026-08-31T10:05:00Z',
        logs: '/commands/c0/logs', log_file: '/workspace/logs/c0.ndjson' },
      { cmd_id: 'cK', command: 'sleep 300', status: 'killed', exit_code: null,
        started_at: '2026-08-31T10:00:00Z', ended_at: '2026-08-31T10:06:00Z',
        logs: '/commands/cK/logs', log_file: '/workspace/logs/cK.ndjson' },
    ],
  };
  const rows = taskChoices(view, Date.parse('2026-08-31T11:00:00Z'));
  assert.ok(rows[0].heading, 'a column header leads the live rows');
  assert.equal(rows[0].label, 'command', 'the header names the label column');
  assert.deepEqual((rows[0].columns ?? []).map((c) => c.text), ['status', 'started', 'ended', 'pid'],
    'the header names the columns');
  const dev = rows[1];
  assert.equal(dev.label, 'npm run dev');
  assert.equal(dev.busy, true, 'a live task spins — it is doing something right now');
  assert.deepEqual(dev.value, { kind: 'live', sid: '142', command: 'npm run dev' });
  assert.equal(dev.columns?.[1].text, '2m', 'started shows in /resume\'s ago vocabulary');
  assert.equal(dev.columns?.[2].text, '', 'ended is blank while running');
  assert.equal(dev.columns?.[3].text, '142', 'pid is the sid — the leader\'s pid, the kill target');
  assert.match(dev.hint ?? '', /output: \/workspace\/logs\/c1\.ndjson/,
    'the hint names the log file where it can actually be read');
  assert.match(rows[2].hint ?? '', /\[k\] still kills it/, 'an untracked task says what it is');
  assert.ok(rows.some((r) => r.heading && r.label === 'finished'));
  const build = rows.find((r) => r.label === 'npm run build')!;
  assert.equal(build.columns?.[0].text, 'exited (0)');
  assert.equal(build.columns?.[2].text, '55m', 'a finished command shows when it ended');
  assert.equal(build.columns?.[3].text, '', 'no live process, no pid');
  const killed = rows.find((r) => r.label === 'sleep 300')!;
  assert.equal(killed.columns?.[0].text, 'killed');
  // The empty states say why the screen is empty, on the list itself.
  assert.match(taskChoices(emptyTasks())[0].label, /nothing running/);
  assert.match(taskChoices(emptyTasks('absent'))[0].label, /container not running/);
});

test('the toolbar counts tasks beside the mode — 0 included — and /tasks lists them', async () => {
  let view: TasksView = emptyTasks();
  const rest = async (_m: string, path: string) =>
    path === '/sessions/s1/tasks' ? view as unknown as Record<string, unknown> : {};
  const { stdin, lastFrame } = app({ api: settingsApi({}, [], rest), taskPollMs: 120 });
  await sleep(100);
  assert.match(strip(lastFrame() ?? ''), /» code mode on · 0 tasks/,
    'zero is a state, not silence — the count always rides beside the mode');
  // A dev server starts elsewhere (the agent's turn, another window): the
  // minute clock picks it up without a keypress.
  view = { container: 'running', tasks: [liveTask(), liveTask({ sid: '9', command: 'sleep 300', cmd_id: null, logs: null })], recent: [] };
  await sleep(300);
  assert.match(strip(lastFrame() ?? ''), /2 tasks/);
  stdin.write('/tasks'); await sleep(40);
  stdin.write(ENTER); await sleep(140);
  const f = strip(lastFrame() ?? '');
  assert.match(f, /npm run dev/);
  assert.match(f, /running/);
  assert.match(f, /\[k\] kill/, 'the kill key is offered while something runs');
});

test('[k] on /tasks warns once; the same [k] again kills and the list refreshes', async () => {
  const calls: string[] = [];
  let view: TasksView = { container: 'running', tasks: [liveTask()], recent: [] };
  const rest = async (m: string, path: string) => {
    if (path === '/sessions/s1/tasks' && m === 'GET') return view as unknown as Record<string, unknown>;
    if (path === '/sessions/s1/tasks/142' && m === 'DELETE') { view = emptyTasks(); return { sid: '142', cmd_id: 'c1' }; }
    return {};
  };
  const { stdin, lastFrame } = app({ api: settingsApi({}, calls, rest) });
  await sleep(100);
  stdin.write('/tasks'); await sleep(40);
  stdin.write(ENTER); await sleep(140);
  stdin.write('k'); await sleep(120);
  assert.ok(!calls.some((c) => c.startsWith('DELETE /sessions/s1/tasks/')), 'the first [k] only warns');
  assert.match(strip(lastFrame() ?? ''), /kill "npm run dev"\? — \[k\] again to kill/);
  stdin.write('k'); await sleep(200);
  assert.ok(calls.includes('DELETE /sessions/s1/tasks/142'), 'the second [k] kills');
  assert.match(strip(lastFrame() ?? ''), /nothing running/, 'the list refreshed in place');
});

test('/tasks refreshes itself while open on pollMs; closing stops the clock', async () => {
  let reads = 0;
  let view: TasksView = emptyTasks();
  const rest = async (_m: string, path: string) => {
    if (path === '/sessions/s1/tasks') { reads++; return view as unknown as Record<string, unknown>; }
    return {};
  };
  const { stdin, lastFrame } = app({ api: settingsApi({}, [], rest), pollMs: 120 });
  await sleep(100);
  stdin.write('/tasks'); await sleep(40);
  stdin.write(ENTER); await sleep(140);
  const opened = reads;
  view = { container: 'running', tasks: [liveTask({ command: 'sleep 300' })], recent: [] };
  await sleep(320);                              // a couple of pollMs ticks
  assert.ok(reads > opened, 'the open list re-reads the server on its own');
  assert.match(strip(lastFrame() ?? ''), /sleep 300/, 'new rows land without a keypress');
  stdin.write(ESC); await sleep(60);
  const closed = reads;
  await sleep(320);
  assert.equal(reads, closed, 'closed, the while-open refresh stops');
});

// ── /archived ───────────────────────────────────────────────────────────────
import { archivedChoices } from './components/Archived.js';
import type { Card } from './board.js';

const archCard = (over: Partial<Card> & { id: number; seq: number; title: string }): Card => ({
  status: 'done', pos: 1, details: '', user_story: '', requirements: [],
  blocked_reason: null, auto_plan: null, auto_build: null, pinned: false, archived: true,
  created_at: '2026-08-20T00:00:00Z', updated_at: '2026-08-30T00:00:00Z', ...over });

test('archivedChoices: board-shaped rows under card · was in · when, the story as the hint, empty state', () => {
  const now = Date.parse('2026-08-31T00:00:00Z');
  const [header, row] = archivedChoices([
    archCard({ id: 5, seq: 5, title: 'old card', status: 'in_progress', user_story: 'the story' })], now);
  assert.ok(header.heading);
  assert.equal(header.label, 'card');
  assert.deepEqual(header.columns?.map((c) => c.text), ['was in', 'when']);
  assert.equal(row.label, '5-old card');
  assert.equal(row.columns?.[0].text, 'in progress');
  assert.equal(row.columns?.[1].text, '24h');
  assert.equal(row.hint, 'the story');
  assert.match(archivedChoices([])[0].label, /nothing archived/);
});

test('/archived lists archived cards newest first; [r] restores with a notice; enter opens the card', async () => {
  const cards = [
    archCard({ id: 5, seq: 5, title: 'old card', user_story: 'the story of five' }),
    archCard({ id: 6, seq: 6, title: 'older card', status: 'doing', updated_at: '2026-08-25T00:00:00Z' })];
  const calls: string[] = [];
  const rest = async (m: string, path: string, body?: unknown) => {
    if (m === 'GET' && path.startsWith('/workspaces/w1/cards')) {
      // The route's three read modes, mirrored: the archive listing (newest
      // change first), the one-card seq lookup, the board (unarchived).
      if (path.includes('archived=only'))
        return { cards: cards.filter((t) => t.archived)
          .sort((a, b) => b.updated_at.localeCompare(a.updated_at) || b.id - a.id) };
      const seq = /[?&]seq=(\d+)/.exec(path);
      if (seq) return { cards: cards.filter((t) => t.seq === Number(seq[1])) };
      return { prefix: 'PHA', columns: ['backlog', 'doing', 'done'], cards: cards.filter((t) => !t.archived) };
    }
    if (m === 'PATCH' && path.includes('/cards/')) {
      const t = cards.find((c) => c.id === Number(path.split('/').pop()))!;
      Object.assign(t, body as object); return { card: t };
    }
    return {};
  };
  const { stdin, lastFrame } = app({ api: settingsApi({}, calls, rest), newTools: async () => ({}) });
  await sleep(80);
  stdin.write('/archived'); await sleep(40);
  stdin.write(ENTER); await sleep(140);
  assert.ok(calls.some((c) => c.includes('/cards?archived=only&limit=30')),
    'the archive is its own paged fetch — never part of the board download');
  let f = strip(lastFrame() ?? '');
  assert.match(f, /card\s+was in\s+when/, 'the table header');
  assert.match(f, /5-old card\s+done/);
  assert.match(f, /6-older card\s+doing/);
  assert.ok(f.indexOf('5-old card') < f.indexOf('6-older card'), 'newest change first');
  assert.match(f, /the story of five/, 'the hint reads the highlighted card');
  stdin.write('r'); await sleep(120);
  assert.ok(calls.some((c) => c.startsWith('PATCH /workspaces/w1/cards/5') && c.includes('"archived":false')),
    'restore PATCHes archived: false');
  f = strip(lastFrame() ?? '');
  assert.match(f, /restored 5-old card → done/, 'the notice names the destination');
  assert.ok(!f.includes('5-old card  '), 'the restored card leaves the list');
  stdin.write(ENTER); await sleep(140);
  assert.match(strip(lastFrame() ?? ''), /PHA-6/, 'enter opens the card editor');
  stdin.write(ESC); await sleep(700); // esc flushes the editor's debounce, then closes
  assert.match(strip(lastFrame() ?? ''), /» code mode on/, 'the editor closes to chat');
});

// ── the shared table system ─────────────────────────────────────────────────
import { tableChoices } from './components/table.js';

test('tableChoices: one header aligned over the rows, fixed and content-sized columns', () => {
  const rows = [
    { value: 'a', cells: ['alpha', 'running', 'now'], busy: true },
    { value: 'b', cells: ['a-much-longer-label', 'exited (0)', '2h'] },
  ];
  const [header, ...body] = tableChoices('name', [{ title: 'status', width: 13 }, { title: 'when' }], rows);
  assert.ok(header.heading);
  // The header is a structured ROW — its label is the label column's title,
  // its columns carry the titles with the SAME widths as the data rows.
  // SelectList renders header and rows through one layout path, so a padded
  // header string that could drift from the rows no longer exists.
  assert.equal(header.label, 'name');
  assert.deepEqual(header.columns, [{ text: 'status', width: 13 }, { text: 'when' }]);
  assert.deepEqual(body[0].columns, [{ text: 'running', width: 13 }, { text: 'now' }]);
  assert.equal(body[0].busy, true);
  // A content-sized column takes its widest cell (capped), title included —
  // and the header carries that computed width too.
  const sized = tableChoices('n', [{ title: 'status', cap: 20 }, { title: 'end' }],
    [{ value: 1, cells: ['x', 'exited (127)', 'now'] }]);
  assert.equal(sized[1].columns?.[0].width, 'exited (127)'.length + 2);
  assert.equal(sized[0].columns?.[0].width, 'exited (127)'.length + 2,
    'the header shares the computed width');
});

test('tableChoices: a marked cell carries its mark to the Column and counts the mark\'s two cells', () => {
  const [header, row] = tableChoices('n', [{ title: 'status', cap: 20 }, { title: 'end' }],
    [{ value: 1, cells: ['x', { text: 'exited (127)', mark: 'red' }, { text: 'now', mark: 'green' }] }]);
  assert.deepEqual(row.columns, [{ text: 'exited (127)', width: 'exited (127)'.length + 2 + 2, mark: 'red' },
    { text: 'now', mark: 'green' }]);
  // The header is never marked, and shares the widened column.
  assert.deepEqual(header.columns, [{ text: 'status', width: 'exited (127)'.length + 4 }, { text: 'end' }]);
  // A plain string cell emits no `mark` key at all (deepEqual elsewhere
  // relies on the shape being exactly { text, width? }).
  const plain = tableChoices('n', [{ title: 's' }], [{ value: 1, cells: ['x', 'y'] }])[1].columns![0];
  assert.ok(!('mark' in plain));
});

// ── the provider and model rows, every screen ────────────────────────────────
// A provider row offers only providers with a key on /keys; a model row's
// catalog follows its own provider, else the coding agent's — and with no
// provider set anywhere there is no catalog to fetch.
import { providerChoices, providerForModelRow } from './components/Settings.js';

test('provider rows list the keyed providers only, and all four with a note while none has a key', () => {
  const keyed = providerChoices('provider', undefined, { anthropic_api_key: 'a', google_api_key: 'g' });
  assert.deepEqual(keyed?.choices, ['anthropic', 'google']);
  assert.deepEqual(providerChoices('supervisor_provider', ['anthropic', 'openai'], { openai_api_key: 'o' })?.choices, ['openai']);
  const none = providerChoices('assistant_provider', undefined, {});
  assert.deepEqual(none?.choices, ['anthropic', 'openai', 'google', 'openai-compatible']);
  assert.match(none?.note ?? '', /no provider key on \/keys yet/);
  assert.equal(providerChoices('model', undefined, {}), null, 'not a provider row');
});

test('a model row follows its own provider, then the coding agent\'s, then none', () => {
  assert.equal(providerForModelRow('model', { provider: 'anthropic' }), 'anthropic');
  assert.equal(providerForModelRow('assistant_model', { provider: 'anthropic', assistant_provider: 'google' }), 'google');
  assert.equal(providerForModelRow('git_fixer_model', { provider: 'openai', git_fixer_provider: '' }), 'openai');
  assert.equal(providerForModelRow('supervisor_model', { provider: null }), null);
  assert.equal(providerForModelRow('reasoning', { provider: 'anthropic' }), null, 'not a model row');
});
