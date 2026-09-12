// Telegram slash commands. Answered from the database — a command runs NO
// agent turn. Two independent knobs, each with its own commands: WHICH session
// the account points at (`/sessions n`, `/new` — pointer only) and WHO answers
// a plain message (`/code`, `/assistant` — the only two doors between modes).
//
// The menus are per mode (chat scope, swapped by enterMode). Each mode shows
// only what belongs in that context — assistant mode shows workspace/session
// navigation and server basics; code mode shows the coding session's own
// actions plus model management. Every handler still answers correctly from
// either mode (graceful errors), so a typed command never goes unanswered.
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
import { titled } from './client.js';
import { toTelegram } from './entities.js';
import type { TelegramEngine } from './engine.js';
import type { TelegramMode } from './store.js';
import { PROVIDERS } from '../../core/llm/createAgent.js';
import { hasCatalog, latestModel, modelsFor } from '../models.js';
import { resolveMany, resolveCredential, credentialForProvider } from '../settings.js';

interface Cmd { command: string; description: string }

/** The menus — one per mode. Assistant mode shows workspace/session navigation
 *  and server basics; code mode shows the coding session's actions plus model
 *  management. No shared COMMON array — each menu is explicit about what
 *  belongs in that context. */
export const MENU: Record<TelegramMode, Cmd[]> = {
  assistant: [
    { command: 'code', description: 'Talk to the coding agent' },
    { command: 'workspaces', description: 'List or switch workspaces' },
    { command: 'sessions', description: 'List or switch sessions' },
    { command: 'status', description: 'Server, workspace and session overview' },
    { command: 'presets', description: 'List or apply model presets' },
    { command: 'restart', description: 'Restart the server (or one service)' },
    { command: 'help', description: 'List commands' },
  ],
  code: [
    { command: 'assistant', description: 'Talk to the assistant' },
    { command: 'sessions', description: 'List or switch sessions' },
    { command: 'new', description: 'Start a new coding session' },
    { command: 'pin', description: 'Pin active session to the top' },
    { command: 'plan', description: 'Toggle plan mode' },
    { command: 'auto_push', description: 'Push this session to base' },
    { command: 'auto_pull', description: 'Pull base into this session' },
    { command: 'stop', description: 'Stop the running task' },
    { command: 'status', description: 'Server, session and what\'s running' },
    { command: 'presets', description: 'List or apply model presets' },
    { command: 'update', description: 'Check for updates' },
    { command: 'restart', description: 'Restart the server (or one service)' },
    { command: 'help', description: 'List commands' },
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
      await client.sendMarkdown(dm, titled('ℹ️ phantom-looper', HELP));
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
        `${i + 1}. ${s.pinned ? '📌 ' : ''}${s.name ?? 'untitled'}${s.id === acc.activeSessionId ? ' (active)' : ''}${s.locked ? ' (busy)' : ''}`);
      await client.sendMarkdown(dm, titled('📋 Sessions:', [...rows, '',
        'Pick one with /sessions <number>; /code <number> talks to its coding agent'].join('\n')));
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
      await client.sendMarkdown(dm, titled('📋 Workspaces:', [...rows, '', 'Switch with /workspaces <number>'].join('\n')));
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

    case 'pin': {
      // The pointer's flag, whoever is answering — like /sessions, not a
      // coding-agent act. Toggles; the row says which way.
      if (!acc.activeSessionId) { await reply('⚠️ Pick a session first — /sessions or /new.'); return; }
      const s = await sessionRow(engine, acc.activeSessionId);
      if (!s) { await reply('⚠️ That session no longer exists — /sessions for a fresh list.'); return; }
      const next = !s.pinned;
      await engine.call(`/sessions/${acc.activeSessionId}`, { method: 'PATCH', body: { pinned: next } });
      await reply(next
        ? `📌 Pinned ${s.name ?? 'untitled'} — it sits at the top of the session list.`
        : `Unpinned ${s.name ?? 'untitled'}.`);
      return;
    }

    case 'status': {
      // Unified: always server + workspace + session; code mode adds the
      // coding session's details. One command, same structure, additive.
      const sysJ = await (await engine.call('/system/status')).json().catch(() => null);
      const serverLine = sysJ?.ok ? String(sysJ.data.text ?? '') : '(unavailable)';

      const w = acc.activeWorkspaceId ? await workspaceRow(engine, acc.activeWorkspaceId) : null;
      const s = acc.activeSessionId ? await sessionRow(engine, acc.activeSessionId) : null;

      const lines: (string | null)[] = [
        serverLine, '',
        `Workspace: ${w?.name ?? acc.activeWorkspaceId ?? '(none — /workspaces)'}`,
        `Session: ${s?.name ?? (acc.activeSessionId ? 'untitled' : '(none — /sessions or /new)')}`,
      ];

      // In code mode with an active session, append the coding details.
      if (acc.mode === 'code' && s) {
        const t = await (await engine.call(`/sessions/${acc.activeSessionId}/tasks`)).json().catch(() => null);
        const tasks = t?.ok ? (t.data.tasks ?? []).length : 0;
        const where = [s.branch ? `Branch: ${s.branch}` : null, s.card != null ? `Card #${s.card}` : null]
          .filter(Boolean).join(' · ');
        lines.push('',
          where || null,
          `Running: ${s.locked ? `yes${s.lockedLabel ? ` (${s.lockedLabel})` : ''}` : 'no'}`,
          `Last request: ${s.lastUserMessage ? oneLine(s.lastUserMessage) : '(none yet)'}`,
          `Plan mode: ${s.planMode ? 'on' : 'off'}`,
          `Background tasks: ${tasks}`);
      }

      await client.sendMarkdown(dm, titled('📊 Status', lines.filter((v) => v != null).join('\n')));
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
        await client.sendMarkdown(dm, titled(
          `✅ Provider: ${p}${model ? ` — model: ${model} (the catalog's newest)` : ''}`,
          [...(p === 'openai-compatible'
            ? ['⚠️ openai-compatible also needs an endpoint and a model id — set both in the cli under /model.', ''] : []),
          'See the top models with /models; switch with /models <number>.',
          ].join('\n')));
        return;
      }
      // Only show providers the user has a key for (plus the current one).
      const keyed: string[] = [];
      for (const p of PROVIDERS) {
        if (p === current) { keyed.push(p); continue; }          // always show the active one
        const v = await resolveCredential(engine.db, engine.key, credentialForProvider(p));
        if (v) keyed.push(p);
      }
      if (!keyed.length) {
        await reply('⚠️ No provider keys configured yet.');
        return;
      }
      providerList.set(dm, keyed);
      const rows = keyed.map((p, i) => {
        const d = latestModel(p);
        const note = d ? ` → ${d}`
          : hasCatalog(p) ? ' — catalog list unavailable right now'
            : ' — no catalog (set model + endpoint in the cli)';
        return `${i + 1}. ${p}${note}${p === current ? ' (current)' : ''}`;
      });
      await client.sendMarkdown(dm, titled('🧠 Providers:', [...rows, '',
        'Switch with /providers <number> — the model follows the catalog\'s newest shown above'].join('\n')));
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
      await client.sendMarkdown(dm, titled(`🧠 Models — ${provider} (current: ${model ?? 'none'}):`,
        [...rows, '',
        'Switch with /models <number>; any other id can be set in the cli under /model'].join('\n')));
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
        await client.sendMarkdown(dm, titled(
          `✅ Applied preset "${p.name}" — ${provider ?? 'no provider'}${model ? ` / ${model}` : ''}.`,
          'See the top models with /models; switch with /models <number>.'));
        return;
      }
      presetList.set(dm, list.map((p) => p.id));
      const rows = list.map((p, i) => `${i + 1}. ${p.name}${presetSummary(p.values)}`);
      await client.sendMarkdown(dm, titled('🧰 Presets:', [...rows, '', 'Apply one with /presets <number>'].join('\n')));
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
      // Legacy alias — folded into /status but still answered if typed.
      const j = await (await engine.call('/system/status')).json().catch(() => null);
      if (!j?.ok) { await reply(`⚠️ Couldn't read the server status: ${j?.error?.message ?? 'no answer from the server'}`); return; }
      const text = String(j.data.text ?? '');
      await client.sendMarkdown(dm, titled('🖥 Server status', text + '\n\nℹ️ /cpu is now part of /status'));
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
      await client.sendMarkdown(dm, titled(`⚠️ I don't know /${cmd}`, titled('ℹ️ phantom-looper', HELP)));
  }
}

/** One bubble for a multi-step run: sent with its title, then EDITED as each
 *  step arrives (a `·` line per step) and once more with the result line. A
 *  client that hands back no message id (or an edit that fails — an unchanged
 *  body, a deleted message) falls back to a fresh message for the result, so
 *  the outcome is never lost. */
async function stepBubble(client: TelegramClient, dm: number, title: string) {
  const steps: string[] = [];
  const m = await client.sendMessage(dm, title).catch(() => null);
  const id: number | null = m?.message_id ?? null;
  // Chain edits so the next waits for the previous — Telegram rate-limits
  // edits to the same message and silently drops fast ones.
  let pending: Promise<boolean> = Promise.resolve(true);
  const edit = () => {
    if (id == null) return Promise.resolve(false);
    const fmt = toTelegram(titled(title, steps.join('\n')));
    pending = pending.then(
      () => client.editMessageText(dm, id, fmt.text, fmt.entities).then(() => true, () => false),
    );
    return pending;
  };
  return {
    step(label: string) { steps.push(`· ${label}`); void edit(); },
    async end(result: string) {
      steps.push(result);
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
  name?: string | null; planMode?: boolean; pinned?: boolean; branch?: string | null; card?: number | null;
  locked?: boolean; lockedLabel?: string | null; lastUserMessage?: string | null;
} | null> {
  const j = await (await engine.call(`/sessions/${id}`)).json();
  return j.ok ? j.data : null;
}

// /help's body — grouped by context. The 'ℹ️ phantom-looper' header is the
// sender's title, not part of the body.
const HELP = [
  'Two agents answer here: the assistant and the active session\'s coding agent. '
  + '/assistant and /code choose which one your messages go to.',
  '',
  'Who answers',
  '/code — Talk to the coding agent',
  '/code 2 — Make session 2 active and talk to its coding agent',
  '/assistant — Talk to the assistant',
  '',
  'Navigation',
  '/workspaces — List workspaces; /workspaces 2 switches',
  '/sessions — List sessions; /sessions 2 switches',
  '',
  'Coding session',
  '/new — Start a new coding session',
  '/pin — Pin active session to the top',
  '/plan — Toggle plan mode',
  '/auto_push — Push this session to base',
  '/auto_pull — Pull base into this session',
  '/stop — Stop the running task',
  '',
  'Model',
  '/presets — List or apply model presets',
  '/providers — List or switch LLM providers',
  '/models — List or switch models',
  '',
  'Server',
  '/status — Server health, workspace, session and what\'s running',
  '/restart — Restart the server; /restart postgres restarts one service',
  '/update — Check for updates',
  '',
  '/help — This list',
].join('\n');
