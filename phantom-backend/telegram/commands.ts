// Telegram slash commands. Answered from the database — a command runs NO
// agent turn. Two independent knobs, each with its own commands: WHICH session
// the account points at (`/sessions n`, `/new` — pointer only) and WHO answers
// a plain message (`/code`, `/assistant` — the only two doors between modes).
// The menu is per mode (chat scope, swapped by enterMode) and is a HINT: every
// handler answers correctly whichever mode you are in.
//
// Merged pairs: `/sessions` lists, `/sessions 2` points at number 2;
// `/workspaces` lists, `/workspaces 2` switches. No singular /session or
// /workspace.

import type { TelegramClient } from './client.js';
import type { TelegramEngine } from './engine.js';
import type { TelegramMode } from './store.js';

interface Cmd { command: string; description: string }

const COMMON: Cmd[] = [
  { command: 'sessions', description: 'List or switch sessions' },
  { command: 'new', description: 'Start a new session' },
  { command: 'stop', description: 'Stop the running task' },
  { command: 'status', description: "Show what's running" },
  { command: 'help', description: 'List commands' },
];

/** The menus — one per mode. Home shows the door INTO a session's coding
 *  agent; code mode shows the door home plus the coder's own actions. */
export const MENU: Record<TelegramMode, Cmd[]> = {
  assistant: [
    { command: 'code', description: 'Talk to the coding agent' },
    { command: 'workspaces', description: 'List or switch workspaces' },
    ...COMMON,
  ],
  code: [
    { command: 'assistant', description: 'Talk to the assistant' },
    { command: 'plan', description: 'Toggle plan mode' },
    { command: 'autopush', description: 'Push this session\'s work' },
    ...COMMON,
  ],
};

/** The menu for a mode (test/telegram.test.ts pins that every entry in each
 *  is a command handleCommand answers, so a menu entry never goes unanswered). */
export function menuFor(mode: TelegramMode): Cmd[] { return MENU[mode]; }

// Per-chat numbered lists — /sessions n and /workspaces n read positions off
// the list the same command last printed. In-memory; a stale index misses and
// re-prompts, never acts on the wrong row.
const sessionList = new Map<number, string[]>();
const workspaceList = new Map<number, string[]>();

/** Handle a slash command. `text` starts with '/'. */
export async function handleCommand(
  engine: TelegramEngine, client: TelegramClient, dm: number, text: string,
): Promise<void> {
  const [raw, ...rest] = text.slice(1).trim().split(/\s+/);
  const cmd = raw.toLowerCase().split('@')[0];
  const arg = rest[0];
  const reply = (m: string) => client.sendMessage(dm, m);
  const acc = await engine.store.getAccount(engine.db, engine.key);

  switch (cmd) {
    case 'start':
    case 'help':
      await reply(`ℹ️ ${HELP}`);
      return;

    case 'assistant':
      // The switch line IS the reply; repeat it when there was nothing to switch.
      if (!await engine.enterMode(client, dm, 'assistant')) {
        await reply(engine.store.MODE_MESSAGE.assistant);
      }
      return;

    case 'code': {
      // Hand the conversation to the active session's coding agent — the ONE
      // slash command that routes there. `/code n` points at n first.
      if (arg !== undefined) {
        const id = listedSession(dm, arg);
        if (!id) { await reply('⚠️ Send /sessions first to see the list, then /code <number>.'); return; }
        const r = await engine.switchSession(client, dm, id);
        if ('error' in r) { await reply('⚠️ That session no longer exists — /sessions for a fresh list.'); return; }
      } else if (!acc.activeSessionId) {
        await reply('⚠️ Pick a session first — /sessions or /new.');
        return;
      }
      if (!await engine.enterMode(client, dm, 'code')) {
        await reply(engine.store.MODE_MESSAGE.code);
      }
      return;
    }

    case 'sessions': {
      // With a number: point at that session. The pointer only — whoever is
      // answering keeps answering; /code is the door to the coding agent.
      if (arg !== undefined) {
        const id = listedSession(dm, arg);
        if (!id) { await reply('⚠️ Send /sessions first to see the list, then /sessions <number>.'); return; }
        const r = await engine.switchSession(client, dm, id);
        if ('error' in r) { await reply('⚠️ That session no longer exists — /sessions for a fresh list.'); return; }
        return;
      }
      // Bare: list them.
      const j = await (await engine.call('/sessions?typed=true&supervisor=false&limit=10')).json();
      if (!j.ok || !j.data.sessions.length) { await reply('ℹ️ No sessions yet. /new starts one.'); return; }
      sessionList.set(dm, j.data.sessions.map((s: any) => s.id));
      const rows = j.data.sessions.map((s: any, i: number) =>
        `${i + 1}. ${s.name ?? 'untitled'}${s.id === acc.activeSessionId ? ' (active)' : ''}${s.locked ? ' (busy)' : ''}`);
      await reply(['📋 Sessions:', ...rows, '',
        'Pick one with /sessions <number>; /code <number> talks to its coding agent'].join('\n'));
      return;
    }

    case 'workspaces': {
      const j = await (await engine.call('/workspaces')).json();
      const list: any[] = j.ok ? (j.data.workspaces ?? j.data) : [];
      if (!Array.isArray(list) || !list.length) { await reply('ℹ️ No workspaces yet — add one in phantom-cli.'); return; }
      // With a number: switch.
      if (arg !== undefined) {
        const ids = workspaceList.get(dm);
        const n = Number.parseInt(arg, 10);
        if (!ids || !Number.isInteger(n) || n < 1 || n > ids.length) {
          await reply('⚠️ Send /workspaces first to see the list, then /workspaces <number>.');
          return;
        }
        const w = list.find((x) => x.id === ids[n - 1]);
        await engine.store.setActiveWorkspace(engine.db, ids[n - 1]);
        await reply(`📁 Active workspace: ${w?.name ?? ids[n - 1]}`);
        return;
      }
      workspaceList.set(dm, list.map((w) => w.id));
      const rows = list.map((w, i) => `${i + 1}. ${w.name}${w.id === acc.activeWorkspaceId ? ' (active)' : ''}`);
      await reply(['📋 Workspaces:', ...rows, '', 'Switch with /workspaces <number>'].join('\n'));
      return;
    }

    case 'new': {
      const ws = acc.activeWorkspaceId;
      if (!ws) { await reply('⚠️ No active workspace — /workspaces to pick one first.'); return; }
      const j = await (await engine.call('/sessions', { method: 'POST', body: { workspace_id: ws } })).json();
      if (!j.ok) { await reply(`⚠️ Couldn't start a session: ${j.error?.message}`); return; }
      // Create + point at it. The mode is untouched: from home the assistant
      // keeps the conversation; in code mode the next message starts the coder.
      await engine.store.setActiveSession(engine.db, j.data.id);
      await reply(acc.mode === 'code'
        ? '🆕 New session. Send your first message to begin.'
        : '🆕 New session is active — /code to start coding in it.');
      return;
    }

    case 'status': {
      if (acc.mode === 'code' && acc.activeSessionId) {
        const s = await sessionRow(engine, acc.activeSessionId);
        const t = await (await engine.call(`/sessions/${acc.activeSessionId}/tasks`)).json().catch(() => null);
        const tasks = t?.ok ? (t.data.tasks ?? []).length : 0;
        const where = [s?.branch ? `Branch: ${s.branch}` : null, s?.card != null ? `card #${s.card}` : null]
          .filter(Boolean).join(' · ');
        await reply(['🤖 Coding agent',
          `Active session: ${s?.name ?? 'untitled'}`,
          where || null,
          `Running: ${s?.locked ? `yes${s.lockedLabel ? ` (${s.lockedLabel})` : ''}` : 'no'}`,
          `Last request: ${s?.lastUserMessage ? oneLine(s.lastUserMessage) : '(none yet)'}`,
          `Plan mode: ${s?.planMode ? 'on' : 'off'}`,
          `Background tasks: ${tasks}`].filter(Boolean).join('\n'));
      } else {
        const w = acc.activeWorkspaceId ? await workspaceRow(engine, acc.activeWorkspaceId) : null;
        const s = acc.activeSessionId ? await sessionRow(engine, acc.activeSessionId) : null;
        await reply(['🏠 Assistant',
          `Active workspace: ${w?.name ?? acc.activeWorkspaceId ?? '(none — /workspaces)'}`,
          `Active session: ${s ? `${s.name ?? 'untitled'} (/code to talk to it)` : '(none — /sessions or /new)'}`].join('\n'));
      }
      return;
    }

    case 'plan': {
      if (acc.mode !== 'code' || !acc.activeSessionId) { await reply('⚠️ Plan mode belongs to the coding agent — /code first.'); return; }
      const s = await sessionRow(engine, acc.activeSessionId);
      const next = !s?.planMode;
      await engine.call(`/sessions/${acc.activeSessionId}`, { method: 'PATCH', body: { plan_mode: next } });
      await reply(next ? '📝 Plan mode on — file tools are read-only.' : '🔧 Plan mode off — full tools.');
      return;
    }

    case 'autopush': {
      if (acc.mode !== 'code' || !acc.activeSessionId) { await reply('⚠️ Auto-push runs from the coding agent — /code first.'); return; }
      await reply('🚀 Pushing your work…');
      const body = await (await engine.call('/git/auto-push',
        { method: 'POST', body: {}, session: acc.activeSessionId })).text();
      const last = body.trim().split('\n').filter(Boolean).pop();
      let msg = 'done';
      let failed = false;
      try {
        const o = JSON.parse(last ?? '{}');
        failed = o.error !== undefined;
        msg = o.result ?? o.step ?? o.error ?? 'done';
      } catch { /* stream tail */ }
      await reply(`${failed ? '⚠️' : '✅'} Auto-push: ${msg}`);
      return;
    }

    case 'stop':
      await reply(engine.stop(dm) ? '🛑 Stopping.' : 'ℹ️ Nothing is running.');
      return;

    default:
      await reply(`⚠️ I don't know /${cmd}.\n\nℹ️ ${HELP}`);
  }
}

/** The id at position `arg` of the list /sessions last printed to this chat,
 *  or null when there is no list or the number is off it. */
function listedSession(dm: number, arg: string): string | null {
  const ids = sessionList.get(dm);
  const n = Number.parseInt(arg, 10);
  if (!ids || !Number.isInteger(n) || n < 1 || n > ids.length) return null;
  return ids[n - 1];
}

async function workspaceRow(engine: TelegramEngine, id: string): Promise<{ name?: string } | null> {
  const j = await (await engine.call(`/workspaces/${id}`)).json();
  return j.ok ? j.data : null;
}

/** The first line of a message, clipped — enough to recognise a request. */
function oneLine(text: string, max = 120): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

async function sessionRow(engine: TelegramEngine, id: string): Promise<{
  name?: string | null; planMode?: boolean; branch?: string | null; card?: number | null;
  locked?: boolean; lockedLabel?: string | null; lastUserMessage?: string | null;
} | null> {
  const j = await (await engine.call(`/sessions/${id}`)).json();
  return j.ok ? j.data : null;
}

// /help — the same sentence-case phrases as the menu, one command per line
// with a dash (Telegram's proportional font collapses padded columns), the
// numbered forms as real examples. Two agents, neither the default.
const HELP = [
  'phantom-looper',
  '',
  'Two agents answer here: the assistant, which manages the board, sessions and workspaces, '
  + 'and the active session\'s coding agent. /assistant and /code choose which one your messages go to.',
  '',
  'Sessions',
  '/sessions — List sessions',
  '/sessions 2 — Make session 2 active',
  '/new — Start a new session',
  '',
  'Who answers',
  '/code — Talk to the coding agent',
  '/code 2 — Make session 2 active and talk to its coding agent',
  '/assistant — Talk to the assistant',
  '',
  'Workspaces',
  '/workspaces — List workspaces',
  '/workspaces 2 — Switch to workspace 2',
  '',
  'Coding agent',
  '/plan — Toggle plan mode',
  '/autopush — Push this session\'s work',
  '',
  '/status — Show what\'s running',
  '/stop — Stop the running task',
  '/help — List commands',
].join('\n');
