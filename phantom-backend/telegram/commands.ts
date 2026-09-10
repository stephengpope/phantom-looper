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
//
// `/auto_push` and `/auto_pull` are the project's `/auto-push` / `/auto-pull`
// under Telegram's command law (lowercase letters, digits, underscores — a
// hyphen fails the whole setMyCommands call). Code mode only, like /plan: they
// act on the coding session the account points at. Each runs as ONE bubble
// edited in place — a line per step as it happens, the result on the last line.

import type { TelegramClient } from './client.js';
import type { TelegramEngine } from './engine.js';
import type { TelegramMode } from './store.js';
import { PROVIDERS } from '../../core/llm/createAgent.js';
import { hasCatalog, latestModel, modelsFor } from '../models.js';
import { resolveMany } from '../settings.js';

interface Cmd { command: string; description: string }

const COMMON: Cmd[] = [
  { command: 'sessions', description: 'List or switch sessions' },
  { command: 'new', description: 'Start a new session' },
  { command: 'star', description: 'Pin the active session to the top of the list' },
  { command: 'stop', description: 'Stop the running task' },
  { command: 'status', description: "Show what's running" },
  { command: 'providers', description: 'List or switch LLM providers' },
  { command: 'models', description: 'List or switch models' },
  { command: 'presets', description: 'List or apply model presets' },
  { command: 'update', description: 'Check for updates' },
  { command: 'cpu', description: 'Server status — cpu, memory, disk' },
  { command: 'restart', description: 'Restart the server (or one service)' },
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
    { command: 'auto_push', description: 'Land this session\'s work on the base branch' },
    { command: 'auto_pull', description: 'Bring the base branch into this session' },
    ...COMMON,
  ],
};

/** The menu for a mode. Every entry must be a command handleCommand
 *  answers, so a menu entry never goes unanswered. */
export function menuFor(mode: TelegramMode): Cmd[] { return MENU[mode]; }

// Per-chat numbered lists — /sessions n and /workspaces n read positions off
// the list the same command last printed. In-memory; a stale index misses and
// re-prompts, never acts on the wrong row.
const sessionList = new Map<number, string[]>();
const workspaceList = new Map<number, string[]>();
const providerList = new Map<number, string[]>();
const modelList = new Map<number, string[]>();
const presetList = new Map<number, string[]>();

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
        await reply(await engine.codeModeLabel());
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
        `${i + 1}. ${s.starred ? '⭐ ' : ''}${s.name ?? 'untitled'}${s.id === acc.activeSessionId ? ' (active)' : ''}${s.locked ? ' (busy)' : ''}`);
      await reply(['📋 Sessions:', '', ...rows, '',
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
      await reply(['📋 Workspaces:', '', ...rows, '', 'Switch with /workspaces <number>'].join('\n'));
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

    case 'star': {
      // The pointer's flag, whoever is answering — like /sessions, not a
      // coding-agent act. Toggles; the row says which way.
      if (!acc.activeSessionId) { await reply('⚠️ Pick a session first — /sessions or /new.'); return; }
      const s = await sessionRow(engine, acc.activeSessionId);
      if (!s) { await reply('⚠️ That session no longer exists — /sessions for a fresh list.'); return; }
      const next = !s.starred;
      await engine.call(`/sessions/${acc.activeSessionId}`, { method: 'PATCH', body: { starred: next } });
      await reply(next
        ? `⭐ Starred ${s.name ?? 'untitled'} — pinned to the top of the session list.`
        : `☆ Unstarred ${s.name ?? 'untitled'}.`);
      return;
    }

    case 'status': {
      if (acc.mode === 'code' && acc.activeSessionId) {
        const s = await sessionRow(engine, acc.activeSessionId);
        const t = await (await engine.call(`/sessions/${acc.activeSessionId}/tasks`)).json().catch(() => null);
        const tasks = t?.ok ? (t.data.tasks ?? []).length : 0;
        const where = [s?.branch ? `Branch: ${s.branch}` : null, s?.card != null ? `card #${s.card}` : null]
          .filter(Boolean).join(' · ');
        await reply(['🤖 Coding agent', '',
          `Active session: ${s?.name ?? 'untitled'}`,
          where || null,
          `Running: ${s?.locked ? `yes${s.lockedLabel ? ` (${s.lockedLabel})` : ''}` : 'no'}`,
          `Last request: ${s?.lastUserMessage ? oneLine(s.lastUserMessage) : '(none yet)'}`,
          `Plan mode: ${s?.planMode ? 'on' : 'off'}`,
          `Background tasks: ${tasks}`].filter((v) => v != null).join('\n'));
      } else {
        const w = acc.activeWorkspaceId ? await workspaceRow(engine, acc.activeWorkspaceId) : null;
        const s = acc.activeSessionId ? await sessionRow(engine, acc.activeSessionId) : null;
        await reply(['🏠 Assistant', '',
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

    case 'auto_push':
    case 'auto_pull': {
      const pull = cmd === 'auto_pull';
      const name = pull ? 'Auto-pull' : 'Auto-push';
      if (acc.mode !== 'code' || !acc.activeSessionId) {
        await reply(`⚠️ ${name} runs on the coding session — /code first.`);
        return;
      }
      const bubble = await stepBubble(client, dm, `${pull ? '⬇️' : '🚀'} ${name}`);
      const r = pull
        ? await engine.autoPull(acc.activeSessionId, bubble.step)
        : await engine.autoPush(acc.activeSessionId, bubble.step);
      await bubble.end(outcomeLine(pull, r));
      return;
    }

    case 'providers': {
      // The same PROVIDERS list the cli's /model offers; each row names the
      // catalog's newest model — what an unset `model` resolves to. Switching
      // clears `model` so it follows that default (the cli's /model rule).
      const { provider: current } = await resolveMany(engine.db, ['provider']);
      if (arg !== undefined) {
        const p = listed(providerList, dm, arg);
        if (!p) { await reply('⚠️ Send /providers first to see the list, then /providers <number>.'); return; }
        const j = await (await engine.call('/settings', { method: 'PATCH', body: { provider: p, model: null } })).json();
        if (!j.ok) { await reply(`⚠️ Couldn't switch provider: ${j.error?.message}`); return; }
        const model = latestModel(p);
        await reply([
          `✅ Provider: ${p}${model ? ` — model: ${model} (the catalog's newest)` : ''}`,
          ...(p === 'openai-compatible'
            ? ['', '⚠️ openai-compatible also needs an endpoint and a model id — set both in the cli under /model.'] : []),
          '',
          'See the top models with /models; switch with /models <number>.',
        ].join('\n'));
        return;
      }
      providerList.set(dm, [...PROVIDERS]);
      const rows = PROVIDERS.map((p, i) => {
        const d = latestModel(p);
        const note = d ? ` → ${d}`
          : hasCatalog(p) ? ' — catalog list unavailable right now'
            : ' — no catalog (set model + endpoint in the cli)';
        return `${i + 1}. ${p}${note}${p === current ? ' (current)' : ''}`;
      });
      await reply(['🧠 Providers:', '', ...rows, '',
        'Switch with /providers <number> — the model follows the catalog\'s newest shown above'].join('\n'));
      return;
    }

    case 'models': {
      // The catalog's top 10 for the current provider. The list is a
      // convenience, never a fence — any other id can be typed in the cli.
      const { provider, model } = await resolveMany(engine.db, ['provider', 'model']);
      if (!provider) { await reply('⚠️ No provider yet — pick one with /providers.'); return; }
      const models = modelsFor(provider).slice(0, 10);
      if (!models.length) {
        await reply(`ℹ️ ${provider} has no catalog list — the model is set by id in the cli under /model.`);
        return;
      }
      if (arg !== undefined) {
        const id = listed(modelList, dm, arg);
        if (!id) { await reply('⚠️ Send /models first to see the list, then /models <number>.'); return; }
        const j = await (await engine.call('/settings', { method: 'PATCH', body: { model: id } })).json();
        if (!j.ok) { await reply(`⚠️ Couldn't switch model: ${j.error?.message}`); return; }
        await reply(`✅ Model: ${id}`);
        return;
      }
      modelList.set(dm, models.map((m) => m.id));
      const rows = models.map((m, i) => `${i + 1}. ${m.id}${m.id === model ? ' (current)' : ''}`);
      await reply([`🧠 Models — ${provider} (current: ${model ?? 'none'}):`, '', ...rows, '',
        'Switch with /models <number>; any other id can be set in the cli under /model'].join('\n'));
      return;
    }

    case 'presets': {
      // Saved model configurations. Applying one is the cli's rule: the
      // preset's keys become a PATCH /settings body — set keys write their
      // value, clear keys null the setting, absent keys stay untouched.
      const j = await (await engine.call('/presets')).json();
      const list: Array<{ id: string; name: string; values: Record<string, unknown> }> = j.ok ? j.data : [];
      if (!list.length) { await reply('ℹ️ No presets saved yet — save one in the cli under /presets.'); return; }
      if (arg !== undefined) {
        const id = listed(presetList, dm, arg);
        if (!id) { await reply('⚠️ Send /presets first to see the list, then /presets <number>.'); return; }
        const p = list.find((x) => x.id === id)!;
        const applied = await (await engine.call('/settings', { method: 'PATCH', body: p.values })).json();
        if (!applied.ok) { await reply(`⚠️ Couldn't apply "${p.name}": ${applied.error?.message}`); return; }
        const { provider, model } = await resolveMany(engine.db, ['provider', 'model']);
        await reply([
          `✅ Applied preset "${p.name}" — ${provider ?? 'no provider'}${model ? ` / ${model}` : ''}.`,
          '',
          'See the top models with /models; switch with /models <number>.',
        ].join('\n'));
        return;
      }
      presetList.set(dm, list.map((p) => p.id));
      const rows = list.map((p, i) => `${i + 1}. ${p.name}${presetSummary(p.values)}`);
      await reply(['🧰 Presets:', '', ...rows, '', 'Apply one with /presets <number>'].join('\n'));
      return;
    }

    case 'stop': {
      // One rule everywhere: the runner stops its own turn; to stop someone
      // else's you send the interrupt for the session and the runner hears it
      // on the session feed (the cli's esc-esc posts the same route).
      if (acc.mode === 'code' && acc.activeSessionId) {
        const own = engine.stop(acc.activeSessionId);   // our turn: abort now
        if (!own) {
          const s = await sessionRow(engine, acc.activeSessionId);
          if (!s?.locked) { await reply('ℹ️ Nothing is running.'); return; }
        }
        // The route does the rest of the stop, whoever runs the turn: it kills
        // the session's foreground commands (our own turn's bash included —
        // injectFetch has no socket to close, so no other kill reaches it)
        // and signals every other listener. Idempotent against the abort above.
        await engine.call(`/sessions/${acc.activeSessionId}/interrupt`, { method: 'POST' });
        await reply('🛑 Stopping.');
        return;
      }
      await reply(engine.stop('assistant') ? '🛑 Stopping.' : 'ℹ️ Nothing is running.');
      return;
    }

    case 'update': {
      await engine.upgradeChecker.manualCheck(client, dm);
      return;
    }

    case 'cpu': {
      const j = await (await engine.call('/system/status')).json().catch(() => null);
      if (!j?.ok) { await reply(`⚠️ Couldn't read the server status: ${j?.error?.message ?? 'no answer from the server'}`); return; }
      // Telegram's message ceiling is 4096; the status script is ~30 lines,
      // so the clip is a guard, never the expected path.
      const text = String(j.data.text ?? '');
      await reply(`🖥 Server status\n${text.length > 3800 ? `${text.slice(0, 3800)}…` : text}`);
      return;
    }

    case 'restart': {
      // Accept/decline first — restarting the api cuts every in-flight turn.
      // The gate's bubble records the verdict, so a decline needs no reply.
      const service = arg;
      const accepted = await engine.askApproval(client, dm, {
        label: 'restart',
        subject: service
          ? `service: ${service}`
          : 'the api — the whole server is offline for a few seconds (in-flight replies are cut)',
      });
      if (!accepted) return;
      const j = await (await engine.call('/system/restart',
        { method: 'POST', body: service ? { service } : {} })).json().catch(() => null);
      if (!j?.ok) { await reply(`⚠️ Couldn't restart: ${j?.error?.message ?? 'no answer from the server'}`); return; }
      await reply(service
        ? `🔄 Restarting ${service}.`
        : '🔄 Restarting the api — back in a few seconds. Messages sent now queue until it is.');
      return;
    }

    default:
      await reply(`⚠️ I don't know /${cmd}.\n\nℹ️ ${HELP}`);
  }
}

/** One bubble for a multi-step run: sent with its title, then EDITED as each
 *  step arrives (a `·` line per step) and once more with the result line. A
 *  client that hands back no message id (or an edit that fails — an unchanged
 *  body, a deleted message) falls back to a fresh message for the result, so
 *  the outcome is never lost. */
async function stepBubble(client: TelegramClient, dm: number, title: string) {
  const lines = [title];
  const m = await client.sendMessage(dm, title).catch(() => null);
  const id: number | null = m?.message_id ?? null;
  // Chain edits so the next waits for the previous — Telegram rate-limits
  // edits to the same message and silently drops fast ones.
  let pending: Promise<boolean> = Promise.resolve(true);
  const edit = () => {
    if (id == null) return Promise.resolve(false);
    const text = lines.join('\n');
    pending = pending.then(
      () => client.editMessageText(dm, id, text).then(() => true, () => false),
    );
    return pending;
  };
  return {
    step(label: string) { lines.push(`· ${label}`); void edit(); },
    async end(result: string) {
      lines.push(result);
      if (!await edit()) await client.sendMessage(dm, result);
    },
  };
}

/** The result of a push or a pull as one line. */
export function outcomeLine(pull: boolean, r: { result: string; reason?: string; sha?: string;
  arrived?: string[]; files?: string[]; pushed?: boolean }): string {
  const why = r.reason ? ` — ${r.reason}` : '';
  if (pull) {
    if (r.result === 'merged') {
      const n = r.arrived?.length ?? 0;
      const files = r.files?.length ? `, ${r.files.length} file${r.files.length === 1 ? '' : 's'} changed` : '';
      const backup = r.pushed === false ? ` (branch push failed${why})` : '';
      return `✅ merged ${n} commit${n === 1 ? '' : 's'} from the base branch${files}${backup}`;
    }
    if (r.result === 'clean') return '✅ nothing to pull — the branch already has all of base';
    return `⚠️ ${r.result}${why}`;
  }
  if (r.result === 'pushed') return `✅ landed on the base branch (${(r.sha ?? '').slice(0, 10)})`;
  if (r.result === 'nothing') return '✅ nothing to push — the base branch already has it all';
  return `⚠️ ${r.result}${why}`;
}

/** The entry at position `arg` of the numbered list a command last printed
 *  to this chat, or null when there is no list or the number is off it. */
function listed(list: Map<number, string[]>, dm: number, arg: string): string | null {
  const ids = list.get(dm);
  const n = Number.parseInt(arg, 10);
  if (!ids || !Number.isInteger(n) || n < 1 || n > ids.length) return null;
  return ids[n - 1];
}

const listedSession = (dm: number, arg: string) => listed(sessionList, dm, arg);

/** A preset's provider / model as a short row suffix, when it sets them. */
function presetSummary(values: Record<string, unknown>): string {
  const bits = [values.provider, values.model].filter((v): v is string => typeof v === 'string');
  return bits.length ? ` — ${bits.join(' / ')}` : '';
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
  name?: string | null; planMode?: boolean; starred?: boolean; branch?: string | null; card?: number | null;
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
  '/star — Pin the active session to the top of the list',
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
  'Model',
  '/providers — List providers and the model each selects by default',
  '/providers 2 — Switch to provider 2',
  '/models — List the top models for the current provider',
  '/models 2 — Switch to model 2',
  '/presets — List saved model presets',
  '/presets 2 — Apply preset 2',
  '',
  'Coding agent',
  '/plan — Toggle plan mode',
  '/auto_push — Land this session\'s work on the base branch',
  '/auto_pull — Bring the base branch into this session',
  '',
  '/status — Show what\'s running',
  '/stop — Stop the running task',
  '/update — Check for updates',
  '',
  'Server',
  '/cpu — Server status (cpu, load, memory, disk)',
  '/restart — Restart the server (asks first); /restart postgres restarts one service',
  '',
  '/help — List commands',
].join('\n');
