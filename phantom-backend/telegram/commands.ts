// Telegram slash commands. Answered from the database — a command runs NO
// agent turn. ONE fixed menu for both modes (set once at reconcile, never
// swapped), so there is nothing to go stale in a client's cache. The commands
// are the door between modes and the actions on a session; each answers
// correctly whichever mode you are in.
//
// Merged pairs: `/sessions` lists, `/sessions 2` enters number 2; `/workspaces`
// lists, `/workspaces 2` switches. No singular /session or /workspace.

import type { TelegramClient } from './client.js';
import type { TelegramEngine } from './engine.js';

interface Cmd { command: string; description: string }

/** THE menu — one list, both modes, plain descriptions. */
export const MENU: Cmd[] = [
  { command: 'sessions', description: 'List sessions, or open one by number' },
  { command: 'new', description: 'Start a new session' },
  { command: 'workspaces', description: 'List workspaces, or switch by number' },
  { command: 'assistant', description: 'Back to the assistant' },
  { command: 'status', description: "Show what's running" },
  { command: 'plan', description: 'Turn plan mode on or off' },
  { command: 'autopush', description: 'Run auto-push' },
  { command: 'stop', description: 'Stop the current task' },
  { command: 'help', description: 'Show what I can do' },
];

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
      if (!await engine.store.setMode(engine.db, 'assistant', undefined, reply)) {
        await reply(engine.store.MODE_MESSAGE.assistant);
      }
      return;

    case 'sessions': {
      // With a number: enter that session (code mode).
      if (arg !== undefined) {
        const ids = sessionList.get(dm);
        const n = Number.parseInt(arg, 10);
        if (!ids || !Number.isInteger(n) || n < 1 || n > ids.length) {
          await reply('⚠️ Send /sessions first to see the list, then /sessions <number>.');
          return;
        }
        const id = ids[n - 1];
        const s = await sessionRow(engine, id);
        await engine.store.setMode(engine.db, 'code', id, reply);
        await reply(`🔀 Active session: ${s?.name ?? 'untitled'}`);
        return;
      }
      // Bare: list them.
      const j = await (await engine.call('/sessions?typed=true&supervisor=false&limit=10')).json();
      if (!j.ok || !j.data.sessions.length) { await reply('ℹ️ No sessions yet. /new starts one.'); return; }
      sessionList.set(dm, j.data.sessions.map((s: any) => s.id));
      const rows = j.data.sessions.map((s: any, i: number) =>
        `${i + 1}. ${s.name ?? 'untitled'}${s.locked ? ' (busy)' : ''}`);
      await reply(['📋 Sessions:', ...rows, '', 'Open one with /sessions <number>'].join('\n'));
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
      await engine.store.setMode(engine.db, 'code', j.data.id, reply);
      await reply('🆕 New session. Send your first message to begin.');
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
        await reply(['🏠 Assistant',
          `Active workspace: ${w?.name ?? acc.activeWorkspaceId ?? '(none — /workspaces)'}`].join('\n'));
      }
      return;
    }

    case 'plan': {
      if (acc.mode !== 'code' || !acc.activeSessionId) { await reply('⚠️ Enter a session first — /sessions.'); return; }
      const s = await sessionRow(engine, acc.activeSessionId);
      const next = !s?.planMode;
      await engine.call(`/sessions/${acc.activeSessionId}`, { method: 'PATCH', body: { plan_mode: next } });
      await reply(next ? '📝 Plan mode on — file tools are read-only.' : '🔧 Plan mode off — full tools.');
      return;
    }

    case 'autopush': {
      if (acc.mode !== 'code' || !acc.activeSessionId) { await reply('⚠️ Enter a session first — /sessions.'); return; }
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

const HELP = [
  "I'm your phantom-looper assistant. Talk to me and I'll manage your work — the board, cards,",
  'sessions, workspaces. Open a session and your messages go to its coding agent.',
  '',
  '/sessions [n]     list sessions, or open number n',
  '/new              start a new session',
  '/workspaces [n]   list workspaces, or switch to number n',
  '/assistant        back to the assistant',
  '/status           show what\'s running',
  '/plan             turn plan mode on or off',
  '/autopush         run auto-push',
  '/stop             stop the current task',
  '/help             this',
].join('\n');
