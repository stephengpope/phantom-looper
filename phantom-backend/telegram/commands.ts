// Telegram slash commands. Answered from the database — a command runs NO
// agent turn. Two independent knobs, each with its own commands: WHICH session
// the bot points at (`/sessions n`, `/new` — pointer only) and WHO answers
// a plain message (`/code`, `/assistant` — the only two doors between modes).
//
// The menus are per mode (chat scope, swapped by enterMode). Each mode shows
// only what belongs in that context — assistant mode shows project/session
// navigation and server basics; code mode shows the coding session's own
// actions plus model management. Every handler still answers correctly from
// either mode (graceful errors), so a typed command never goes unanswered.
//
// Merged pairs: `/sessions` lists, `/sessions 2` points at number 2;
// `/projects` lists, `/projects 2` switches. No singular /session or
// /project.
//
// `/auto_push` and `/auto_pull` are the project's `/auto-push` / `/auto-pull`
// under Telegram's command law (lowercase letters, digits, underscores — a
// hyphen fails the whole setMyCommands call). Code mode only, like /plan: they
// act on the coding session the bot points at. Each runs as ONE bubble
// edited in place — a line per step as it happens, the result on the last line.

import { CodingAgent } from '../../core/agents/coding.js';
import type { TelegramApi } from 'phantom-backend-sdk';
import { titled } from 'phantom-backend-sdk';
import { toTelegram } from 'phantom-backend-sdk';
import type { TelegramAssistantBot } from './TelegramAssistantBot.js';
import { MODE_MESSAGE, type TelegramMode } from 'phantom-backend-sdk';
import { PROVIDERS } from 'phantom-client-sdk';
import { hasCatalog } from 'phantom-backend-sdk';
import { isHeld } from 'phantom-backend-sdk';
import { GLOBAL } from 'phantom-backend-sdk';
import { CLIENT_ID, TELEGRAM_STARTER } from './assistant.js';

interface Cmd { command: string; description: string }

/** The menus — one per mode. Assistant mode shows project/session navigation
 *  and server basics; code mode shows the coding session's actions plus model
 *  management. No shared COMMON array — each menu is explicit about what
 *  belongs in that context. */
export const MENU: Record<TelegramMode, Cmd[]> = {
  assistant: [
    { command: 'code', description: 'Talk to the coding agent' },
    { command: 'projects', description: 'List or switch projects' },
    { command: 'sessions', description: 'List or switch sessions' },
    { command: 'stop', description: 'Stop the assistant' },
    { command: 'status', description: 'Server, project and session overview' },
    { command: 'presets', description: 'List or apply model presets' },
    { command: 'tokens', description: 'Token usage by model' },
    { command: 'update', description: 'Check for updates' },
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
    { command: 'stop', description: 'Stop the running coding session' },
    { command: 'status', description: 'Server, session and what\'s running' },
    { command: 'presets', description: 'List or apply model presets' },
    { command: 'tokens', description: 'Token usage by model' },
    { command: 'update', description: 'Check for updates' },
    { command: 'restart', description: 'Restart the server (or one service)' },
    { command: 'help', description: 'List commands' },
  ],
};

/** The menu for a mode. Every entry must be a command handleCommand
 *  answers, so a menu entry never goes unanswered. */
export function menuFor(mode: TelegramMode): Cmd[] { return MENU[mode]; }

// Per-chat numbered lists — /sessions n and /projects n read positions off
// the list the same command last printed. In-memory; a stale index misses and
// re-prompts, never acts on the wrong row.
const sessionList = new Map<number, string[]>();
const projectList = new Map<number, string[]>();
const providerList = new Map<number, string[]>();
const modelList = new Map<number, string[]>();
const presetList = new Map<number, string[]>();

/** Handle a slash command. `text` starts with '/'. */
export async function handleCommand(
  telegram: TelegramAssistantBot, client: TelegramApi, dm: number, text: string,
): Promise<void> {
  const [raw, ...rest] = text.slice(1).trim().split(/\s+/);
  const cmd = raw.toLowerCase().split('@')[0];
  const arg = rest[0];
  const reply = (m: string) => client.sendMessage(dm, m);
  const bot = await telegram.backend.telegramBotState.read();

  switch (cmd) {
    case 'start':
    case 'help':
      await client.sendMarkdown(dm, titled('ℹ️ phantom-looper', HELP));
      return;

    case 'assistant':
      // The switch line IS the reply; repeat it when there was nothing to switch.
      if (!await telegram.enterMode(client, dm, 'assistant')) {
        await reply(MODE_MESSAGE.assistant);
      }
      return;

    case 'code': {
      // Hand the conversation to the active session's coding agent — the ONE
      // slash command that routes there. `/code n` points at n first.
      // Silent: enterMode sends the code-mode label which already carries the
      // session name (and the last agent message), so the 🔀 line is redundant.
      if (arg !== undefined) {
        const id = listedSession(dm, arg);
        if (!id) { await reply('⚠️ Send /sessions first to see the list, then /code <number>.'); return; }
        const r = await telegram.switchSession(client, dm, id, { silent: true });
        if ('error' in r) { await reply('⚠️ That session no longer exists — /sessions for a fresh list.'); return; }
      } else if (!bot.activeSessionId) {
        await reply('⚠️ Pick a session first — /sessions or /new.');
        return;
      }
      if (!await telegram.enterMode(client, dm, 'code')) {
        await reply(await telegram.codeModeLabel(dm));
      }
      return;
    }

    case 'sessions': {
      // With a number: point at that session. The pointer only — whoever is
      // answering keeps answering; /code is the door to the coding agent.
      if (arg !== undefined) {
        const id = listedSession(dm, arg);
        if (!id) { await reply('⚠️ Send /sessions first to see the list, then /sessions <number>.'); return; }
        const r = await telegram.switchSession(client, dm, id);
        if ('error' in r) { await reply('⚠️ That session no longer exists — /sessions for a fresh list.'); return; }
        return;
      }
      // Bare: list them.  Fetch generously, then trim: all pinned + at
      // least 5 non-pinned (target 10 total, but pinned never push recent
      // sessions out of view).
      const { sessions: allSessions } = await telegram.backend.sessions.list({ typed: true, background: false, limit: 30 });
      const pinned = allSessions.filter((s) => s.pinned);
      const nonPinned = allSessions.filter((s) => !s.pinned);
      const sessions = [...pinned, ...nonPinned.slice(0, Math.max(5, 10 - pinned.length))];
      if (!sessions.length) { await reply('ℹ️ No sessions yet. /new starts one.'); return; }
      sessionList.set(dm, sessions.map((s) => s.id));
      const now = Date.now();
      const rows = sessions.map((s, i) =>
        `${i + 1}. ${s.pinned ? '📌 ' : ''}${s.name ?? 'untitled'}${s.id === bot.activeSessionId ? ' (active)' : ''}${isHeld(s, now) ? ' (busy)' : ''}`);
      await client.sendMarkdown(dm, titled('📋 Sessions:', [...rows, '',
        'Pick one with /sessions <number>; /code <number> talks to its coding agent'].join('\n')));
      return;
    }

    case 'projects': {
      const list = await telegram.backend.projects.list();
      if (!list.length) { await reply('ℹ️ No projects yet — add one in phantom-cli.'); return; }
      // With a number: switch.
      if (arg !== undefined) {
        const ids = projectList.get(dm);
        const n = Number.parseInt(arg, 10);
        if (!ids || !Number.isInteger(n) || n < 1 || n > ids.length) {
          await reply('⚠️ Send /projects first to see the list, then /projects <number>.');
          return;
        }
        const project = list.find((x) => x.id === ids[n - 1]);
        await telegram.backend.telegramBotState.setActiveProject(ids[n - 1]);
        await reply(`📁 Active project: ${project?.name ?? ids[n - 1]}`);
        return;
      }
      projectList.set(dm, list.map((project) => project.id));
      const rows = list.map((project, i) => `${i + 1}. ${project.name}${project.id === bot.activeProjectId ? ' (active)' : ''}`);
      await client.sendMarkdown(dm, titled('📋 Projects:', [...rows, '', 'Switch with /projects <number>'].join('\n')));
      return;
    }

    case 'new': {
      const projectId = bot.activeProjectId;
      if (!projectId) { await reply('⚠️ No active project — /projects to pick one first.'); return; }
      let started;
      try { started = await telegram.backend.sessions.start(projectId, CodingAgent.systemPromptLayout, { type: 'coding', startedBy: TELEGRAM_STARTER }); }
      catch (e) { await reply(`⚠️ Couldn't start a session: ${(e as Error).message}`); return; }
      // Create + point at it. The mode is untouched: from home the assistant
      // keeps the conversation; in code mode the next message starts the coder.
      await telegram.backend.telegramBotState.setActiveSession(started.id);
      await reply(bot.mode === 'code'
        ? '🆕 New session. Send your first message to begin.'
        : '🆕 New session is active — /code to start coding in it.');
      return;
    }

    case 'pin': {
      // The pointer's flag, whoever is answering — like /sessions, not a
      // coding-agent act. Toggles; the row says which way.
      if (!bot.activeSessionId) { await reply('⚠️ Pick a session first — /sessions or /new.'); return; }
      const s = await sessionRow(telegram, bot.activeSessionId);
      if (!s) { await reply('⚠️ That session no longer exists — /sessions for a fresh list.'); return; }
      const next = !s.pinned;
      await telegram.backend.sessions.setPinned(bot.activeSessionId, next);
      await reply(next
        ? `📌 Pinned ${s.name ?? 'untitled'} — it sits at the top of the session list.`
        : `Unpinned ${s.name ?? 'untitled'}.`);
      return;
    }

    case 'status': {
      // Project, session + state, agent, mode (code only), server.
      const project = bot.activeProjectId ? await projectRow(telegram, bot.activeProjectId) : null;
      const s = bot.activeSessionId ? await sessionRow(telegram, bot.activeSessionId) : null;

      let sessionLine: string;
      if (s) {
        const state = s.locked ? 'running' : 'idle';
        sessionLine = `${s.name ?? 'untitled'} — ${state}`;
      } else {
        sessionLine = 'none — /sessions or /new';
      }

      const lines = [
        `Project: ${project?.name ?? bot.activeProjectId ?? 'none — /projects'}`,
        `Session: ${sessionLine}`,
        `Agent: ${bot.mode}`,
        ...(bot.mode === 'code' && s ? [`Mode: ${s.planMode ? 'plan' : 'code'}`] : []),
      ];

      // Server stats condensed to one line.
      const sys = await telegram.system.status().catch(() => null);
      if (sys) {
        const raw = sys.text;
        const cpu = raw.match(/(\d+)% busy/)?.[1];
        const mem = raw.match(/([\d.]+G) used .* ([\d.]+G) total\n/);
        const disk = raw.match(/disk.*\n([\d.]+G) used .* ([\d.]+G) free/s);
        const parts = [
          cpu ? `CPU ${cpu}%` : null,
          mem ? `Mem ${mem[1]}/${mem[2]}` : null,
          disk ? `Disk ${disk[2]} free` : null,
        ].filter(Boolean).join(' · ');
        lines.push(`Server: ${parts || raw.split('\n')[0]}`);
      }

      await client.sendMarkdown(dm, titled('📊 Status', lines.join('\n')));
      return;
    }

    case 'plan': {
      if (bot.mode !== 'code' || !bot.activeSessionId) { await reply('⚠️ Plan mode belongs to the coding agent — /code first.'); return; }
      const s = await sessionRow(telegram, bot.activeSessionId);
      const next = !s?.planMode;
      await telegram.backend.sessions.setPlanMode(bot.activeSessionId, next);
      await reply(next ? '📝 Plan mode on — file tools are read-only.' : '🔧 Plan mode off — full tools.');
      return;
    }

    case 'auto_push':
    case 'auto_pull': {
      const pull = cmd === 'auto_pull';
      const name = pull ? 'Auto-pull' : 'Auto-push';
      if (bot.mode !== 'code' || !bot.activeSessionId) {
        await reply(`⚠️ ${name} runs on the coding session — /code first.`);
        return;
      }
      const bubble = await stepBubble(client, dm, `${pull ? '⬇️' : '🚀'} ${name}`);
      const r = pull
        ? await telegram.autoPull(bot.activeSessionId, bubble.step)
        : await telegram.autoPush(bot.activeSessionId, bubble.step);
      await bubble.end(outcomeLine(pull, r));
      return;
    }

    case 'providers': {
      // The same PROVIDERS list the cli's /settings offers; each row names the
      // catalog's newest model — what an unset `model` resolves to. Switching
      // clears `coding_model` so it follows that default (the cli's /settings rule).
      const { coding_provider: current } = await telegram.backend.settings.resolveMany(['coding_provider']);
      if (arg !== undefined) {
        const p = listed(providerList, dm, arg);
        if (!p) { await reply('⚠️ Send /providers first to see the list, then /providers <number>.'); return; }
        try { await telegram.backend.settings.writeAtScope('global', GLOBAL, { coding_provider: p, coding_model: null }, CLIENT_ID); }
        catch (e) { await reply(`⚠️ Couldn't switch provider: ${(e as Error).message}`); return; }
        const model = telegram.backend.modelCatalog.latestFor(p);
        await client.sendMarkdown(dm, titled(
          `✅ Provider: ${p}${model ? ` — model: ${model} (the catalog's newest)` : ''}`,
          [...(p === 'openai-compatible'
            ? ['⚠️ openai-compatible also needs an endpoint and a model id — set both in the cli under /settings.', ''] : []),
          'See the top models with /models; switch with /models <number>.',
          ].join('\n')));
        return;
      }
      // Only show providers the user has a key for (plus the current one).
      const keyed: string[] = [];
      for (const p of PROVIDERS) {
        if (p === current) { keyed.push(p); continue; }          // always show the active one
        const name = telegram.backend.settings.credentialKeyForProvider(p);
        // A provider that holds no key here (openai-codex) is always callable.
        if (!name || await telegram.backend.settings.credential(name)) keyed.push(p);
      }
      if (!keyed.length) {
        await reply('⚠️ No provider keys configured yet.');
        return;
      }
      providerList.set(dm, keyed);
      const rows = keyed.map((p, i) => {
        const d = telegram.backend.modelCatalog.latestFor(p);
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
      const { coding_provider: provider, coding_model: model } = await telegram.backend.settings.resolveMany(['coding_provider', 'coding_model']);
      if (!provider) { await reply('⚠️ No provider yet — pick one with /providers.'); return; }
      const models = telegram.backend.modelCatalog.modelsFor(String(provider)).slice(0, 10);
      if (!models.length) {
        await reply(`ℹ️ ${provider} has no catalog list — the model is set by id in the cli under /settings.`);
        return;
      }
      if (arg !== undefined) {
        const id = listed(modelList, dm, arg);
        if (!id) { await reply('⚠️ Send /models first to see the list, then /models <number>.'); return; }
        try { await telegram.backend.settings.writeAtScope('global', GLOBAL, { coding_model: id }, CLIENT_ID); }
        catch (e) { await reply(`⚠️ Couldn't switch model: ${(e as Error).message}`); return; }
        await reply(`✅ Model: ${id}`);
        return;
      }
      modelList.set(dm, models.map((m) => m.id));
      const rows = models.map((m, i) => `${i + 1}. ${m.id}${m.id === model ? ' (current)' : ''}`);
      await client.sendMarkdown(dm, titled(`🧠 Models — ${provider} (current: ${model ?? 'none'}):`,
        [...rows, '',
        'Switch with /models <number>; any other id can be set in the cli under /settings'].join('\n')));
      return;
    }

    case 'presets': {
      // Saved model configurations. Applying one is the cli's rule: the
      // preset's keys become a PATCH /settings body — set keys write their
      // value, clear keys null the setting, absent keys stay untouched.
      const list = await telegram.backend.presets.list() as Array<{ id: string; name: string; values: Record<string, unknown> }>;
      if (!list.length) { await reply('ℹ️ No presets saved yet — save one in the cli under /presets.'); return; }
      if (arg !== undefined) {
        const id = listed(presetList, dm, arg);
        if (!id) { await reply('⚠️ Send /presets first to see the list, then /presets <number>.'); return; }
        const p = list.find((x) => x.id === id)!;
        try { await telegram.backend.settings.writeAtScope('global', GLOBAL, p.values, CLIENT_ID); }
        catch (e) { await reply(`⚠️ Couldn't apply "${p.name}": ${(e as Error).message}`); return; }
        const { coding_provider: provider, coding_model: model } = await telegram.backend.settings.resolveMany(['coding_provider', 'coding_model']);
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
      // /stop — mode-aware:
      //   assistant mode → stop the assistant turn
      //   code mode      → stop the active coding session
      // /stop n — stop session n from the /sessions list (either mode)
      // /stop all — stop every locked (running) coding session (either mode)
      // Never touches the active-session pointer — it's a remote kill.

      if (arg === 'all') {
        const now = Date.now();
        const locked = (await telegram.backend.sessions.list({ typed: true, background: false, limit: 50 })).sessions.filter((s) => isHeld(s, now));
        if (!locked.length) { await reply('ℹ️ Nothing is running.'); return; }
        const names: string[] = [];
        for (const s of locked) {
          telegram.stop(s.id);
          telegram.interrupt(s.id);
          names.push(s.name ?? 'untitled');
        }
        await reply(`🛑 Stopped ${names.length}: ${names.map((n) => `'${n}'`).join(', ')}.`);
        return;
      }

      // /stop n — a specific session by its number from /sessions.
      if (arg !== undefined) {
        const id = listedSession(dm, arg);
        if (!id) { await reply('⚠️ Send /sessions first to see the list, then /stop <number>.'); return; }
        const s = await sessionRow(telegram, id);
        if (!s) { await reply('⚠️ That session no longer exists — /sessions for a fresh list.'); return; }
        if (!s.locked) { await reply(`ℹ️ ${s.name ?? 'untitled'} isn't running.`); return; }
        telegram.stop(id);
        telegram.interrupt(id);
        await reply(`🛑 Stopping '${s.name ?? 'untitled'}'.`);
        return;
      }

      // Bare /stop — assistant mode stops the assistant; code mode stops
      // the active coding session.
      if (bot.mode === 'assistant') {
        const stopped = telegram.stop('assistant');
        if (!stopped) { await reply('ℹ️ The assistant isn\'t running.'); return; }
        await reply('🛑 Stopping the assistant.');
        return;
      }

      // Code mode — stop the active coding session.
      if (!bot.activeSessionId) { await reply('⚠️ No active session — /sessions to pick one, or /stop all.'); return; }
      const own = telegram.stop(bot.activeSessionId);
      if (!own) {
        const s = await sessionRow(telegram, bot.activeSessionId);
        if (!s?.locked) { await reply('ℹ️ Nothing is running.'); return; }
      }
      telegram.interrupt(bot.activeSessionId);
      await reply('🛑 Stopping.');
      return;
    }

    case 'update': {
      await telegram.upgradeChecker.manualCheck(client, dm);
      return;
    }

    case 'cpu': {
      // Legacy alias — folded into /status but still answered if typed.
      let text: string;
      try { text = (await telegram.system.status()).text; }
      catch (e) { await reply(`⚠️ Couldn't read the server status: ${(e as Error).message}`); return; }
      await client.sendMarkdown(dm, titled('🖥 Server status', text + '\n\nℹ️ /cpu is now part of /status'));
      return;
    }

    case 'tokens': {
      let text: string;
      try { text = (await telegram.system.tokenUsage(await telegram.backend.settings.clockFor())).text; }
      catch (e) { await reply(`⚠️ Couldn't read token usage: ${(e as Error).message}`); return; }
      // A code block: the report is a fixed-column table, monospace only.
      await client.sendMarkdown(dm, titled('📊 Token usage', text ? '```\n' + text + '\n```' : '(no usage data)'));
      return;
    }

    case 'restart': {
      // Accept/decline first — restarting the api cuts every in-flight turn.
      // The gate's bubble records the verdict, so a decline needs no reply.
      const service = arg;
      const accepted = await telegram.askApproval(client, dm, {
        label: 'restart',
        subject: service
          ? `service: ${service}`
          : 'the api — the whole server is offline for a few seconds (in-flight replies are cut)',
      });
      if (!accepted) return;
      try { await telegram.system.restart(service || undefined); }
      catch (e) { await reply(`⚠️ Couldn't restart: ${(e as Error).message}`); return; }
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
async function stepBubble(client: TelegramApi, dm: number, title: string) {
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
  const bits = [values.coding_provider, values.coding_model].filter((v): v is string => typeof v === 'string');
  return bits.length ? ` — ${bits.join(' / ')}` : '';
}

const projectRow = (telegram: TelegramAssistantBot, id: string) => telegram.backend.projects.get(id);

/** The first line of a message, clipped — enough to recognise a request. */
function oneLine(text: string, max = 120): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The session row, with `locked` computed here as the routes compute it. */
async function sessionRow(telegram: TelegramAssistantBot, id: string) {
  const s = await telegram.backend.sessions.get(id);
  return s ? { ...s, locked: isHeld(s, Date.now()) } : null;
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
  '/projects — List projects; /projects 2 switches',
  '/sessions — List sessions; /sessions 2 switches',
  '',
  'Coding session',
  '/new — Start a new coding session',
  '/pin — Pin active session to the top',
  '/plan — Toggle plan mode',
  '/auto_push — Push this session to base',
  '/auto_pull — Pull base into this session',
  '/stop — Stop the assistant or active coding session (mode-aware)',
  '/stop 2 — Stop session 2',
  '/stop all — Stop every running session',
  '',
  'Chat',
  '',
  'Model',
  '/presets — List or apply model presets',
  '/providers — List or switch LLM providers',
  '/models — List or switch models',
  '',
  'Server',
  '/status — Server health and what\'s running',
  '/tokens — Token usage by model',
  '/restart — Restart the server; /restart postgres restarts one service',
  '/update — Check for updates',
  '',
  '/help — This list',
].join('\n');
