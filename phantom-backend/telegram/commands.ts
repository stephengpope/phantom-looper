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
  { command: 'workspaces', description: 'List projects, or switch by number' },
  { command: 'assistant', description: 'Back to the assistant' },
  { command: 'status', description: "Show what's running" },
  { command: 'plan', description: 'Turn plan mode on or off' },
  { command: 'autopush', description: 'Push your work' },
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
      await reply(HELP);
      return;

    case 'assistant':
      await engine.store.setMode(engine.db, 'assistant');
      await reply('🏠 Assistant. Ask me about the board, cards, workspaces, or sessions.');
      return;

    case 'sessions': {
      // With a number: enter that session (code mode).
      if (arg !== undefined) {
        const ids = sessionList.get(dm);
        const n = Number.parseInt(arg, 10);
        if (!ids || !Number.isInteger(n) || n < 1 || n > ids.length) {
          await reply('Send /sessions first to see the list, then /sessions <number>.');
          return;
        }
        const id = ids[n - 1];
        const s = await sessionRow(engine, id);
        await engine.store.setMode(engine.db, 'code', id);
        await reply(`🔀 In session: ${s?.name ?? id}. Your messages now run coding turns on it.`);
        return;
      }
      // Bare: list them.
      const j = await (await engine.call('/sessions?typed=true&supervisor=false&limit=10')).json();
      if (!j.ok || !j.data.sessions.length) { await reply('No sessions yet. /new starts one.'); return; }
      sessionList.set(dm, j.data.sessions.map((s: any) => s.id));
      const rows = j.data.sessions.map((s: any, i: number) =>
        `${i + 1}. ${s.name ?? 'untitled'}${s.locked ? ' (busy)' : ''}`);
      await reply(['Sessions:', ...rows, '', 'Open one with /sessions <number>'].join('\n'));
      return;
    }

    case 'workspaces': {
      const j = await (await engine.call('/workspaces')).json();
      const list: any[] = j.ok ? (j.data.workspaces ?? j.data) : [];
      if (!Array.isArray(list) || !list.length) { await reply('No projects yet — add one in the cli.'); return; }
      // With a number: switch.
      if (arg !== undefined) {
        const ids = workspaceList.get(dm);
        const n = Number.parseInt(arg, 10);
        if (!ids || !Number.isInteger(n) || n < 1 || n > ids.length) {
          await reply('Send /workspaces first to see the list, then /workspaces <number>.');
          return;
        }
        await engine.store.setActiveWorkspace(engine.db, ids[n - 1]);
        await reply('Switched project. The assistant now works on that board.');
        return;
      }
      workspaceList.set(dm, list.map((w) => w.id));
      const rows = list.map((w, i) => `${i + 1}. ${w.name}${w.id === acc.activeWorkspaceId ? ' (current)' : ''}`);
      await reply(['Projects:', ...rows, '', 'Switch with /workspaces <number>'].join('\n'));
      return;
    }

    case 'new': {
      const ws = acc.activeWorkspaceId;
      if (!ws) { await reply('No project selected — /workspaces to pick one first.'); return; }
      const j = await (await engine.call('/sessions', { method: 'POST', body: { workspace_id: ws } })).json();
      if (!j.ok) { await reply(`Couldn't start a session: ${j.error?.message}`); return; }
      await engine.store.setMode(engine.db, 'code', j.data.id);
      await reply('🆕 New session. Send your first message to begin.');
      return;
    }

    case 'status': {
      if (acc.mode === 'code' && acc.activeSessionId) {
        const s = await sessionRow(engine, acc.activeSessionId);
        const t = await (await engine.call(`/sessions/${acc.activeSessionId}/tasks`)).json().catch(() => null);
        const running = t?.ok ? (t.data.tasks ?? []).length : 0;
        await reply(['In a session',
          `Session: ${s?.name ?? acc.activeSessionId}`,
          `Plan mode: ${s?.plan_mode ? 'on' : 'off'}`,
          `Running tasks: ${running}`].join('\n'));
      } else {
        await reply(['Assistant (home)',
          `Project: ${acc.activeWorkspaceId ?? '(none — /workspaces)'}`].join('\n'));
      }
      return;
    }

    case 'plan': {
      if (acc.mode !== 'code' || !acc.activeSessionId) { await reply('Enter a session first — /sessions.'); return; }
      const s = await sessionRow(engine, acc.activeSessionId);
      const next = !s?.plan_mode;
      await engine.call(`/sessions/${acc.activeSessionId}`, { method: 'PATCH', body: { plan_mode: next } });
      await reply(next ? '📝 Plan mode on — file tools are read-only.' : '🔧 Code mode — full tools.');
      return;
    }

    case 'autopush': {
      if (acc.mode !== 'code' || !acc.activeSessionId) { await reply('Enter a session first — /sessions.'); return; }
      await reply('🚀 Pushing your work…');
      const body = await (await engine.call('/git/auto-push',
        { method: 'POST', body: {}, session: acc.activeSessionId })).text();
      const last = body.trim().split('\n').filter(Boolean).pop();
      let msg = 'done';
      try { const o = JSON.parse(last ?? '{}'); msg = o.result ?? o.step ?? o.error ?? 'done'; } catch { /* stream tail */ }
      await reply(`Auto-push: ${msg}`);
      return;
    }

    case 'stop':
      await reply(engine.stop(dm) ? '🛑 Stopping.' : 'Nothing is running.');
      return;

    default:
      await reply(`I don't know /${cmd}.\n\n${HELP}`);
  }
}

async function sessionRow(engine: TelegramEngine, id: string):
Promise<{ name?: string; plan_mode?: boolean } | null> {
  const j = await (await engine.call(`/sessions/${id}`)).json();
  return j.ok ? j.data : null;
}

const HELP = [
  "I'm your phantom-looper assistant. Talk to me and I'll manage your work — the board, cards,",
  'sessions, projects. Open a session and your messages go to its coding agent.',
  '',
  '/sessions [n]     list sessions, or open number n',
  '/new              start a new session',
  '/workspaces [n]   list projects, or switch to number n',
  '/assistant        back to the assistant',
  '/status           show what\'s running',
  '/plan             turn plan mode on or off',
  '/autopush         push your work',
  '/stop             stop the current task',
  '/help             this',
].join('\n');
