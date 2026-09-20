// The Assistant, server-side, for Telegram — assistant MODE, the home the bot
// answers in by default. It is the SAME agent as the cli's side pane
// (core AssistantAgent: same prompt, same Settings.agentConfig('assistant')) — reached over the webhook instead of the
// Python voice sidecar, with HEADLESS tool handlers hitting this server's own
// routes instead of the app's BoardStore.
//
// The conversation is one ModelMessage[] held by the engine, backed by the
// newest transcript file in the server's assistant dir — written as it goes,
// loaded back on boot, so a restart continues the chat. Past the message
// limit it compacts (core/llm/compaction.ts): the summary opens a fresh file
// and the old ones stay as the archive.
//
// Board and sessions are the Assistant's job (create/move cards, list/read
// sessions); the file tools + web are bound to the bot's active session,
// so "what does the auth code look like?" works from home. session_switch
// moves that pointer and nothing else — the Assistant keeps the conversation.
// It never SENDS into a session — /code (code mode) is how you talk to a coder.

import type { ModelMessage, Tool } from 'ai';
import { AssistantAgent } from '../../core/llm/agents/assistant.js';
import { agentClock, type AgentConfig } from '../../core/llm/agentConfig.js';
import type { SessionRow } from '../db/schema.js';
import type { Cards, CardFields, ItemOp, CardRow } from '../cards.js';
import type { Workspaces } from '../workspaces.js';
import { assistantKanbanTool, sessionsTool, workspaceCreateTool, gitAutoPushTool, gitAutoPullTool, dockerLogsTool,
  type KanbanArgs } from '../../core/llm/tools/tui.js';
import { sessionsHandler, workspaceCreateHandler, gitHandlers, dockerLogsHandler,
  type AssistantHost } from '../../core/llm/tools/assistantHandlers.js';
import type { ApiCall } from '../../core/session.js';
import { autoPushSession, autoPullSession } from '../../core/llm/tools/git.js';
import { phantomTools } from '../../core/llm/tools/workspace.js';
import { webTools } from '../../core/llm/tools/web.js';
import { cronTools } from '../../core/llm/tools/crons.js';
import { usageEvent, type Transcript } from '../../core/llm/transcript.js';
import type { TelegramSink } from './sink.js';

const BASE = 'http://looper/api';
/** The bot's session-lock id — one declaration, the engine imports it. */
export const CLIENT_ID = 'telegram';

export interface AssistantDeps {
  f: typeof fetch;
  apiKey: string;
  /** The board's owner, and the workspace rows it is addressed by. */
  cards: Cards;
  workspaces: Workspaces;
  modelFetch?: typeof fetch;
}

type Envelope = { ok: boolean; data?: any; error?: { message?: string } };

async function api(deps: AssistantDeps, path: string,
  init?: { method?: string; body?: unknown; session?: string }): Promise<Envelope> {
  const headers: Record<string, string> = { authorization: `Bearer ${deps.apiKey}` };
  if (init?.body !== undefined) headers['content-type'] = 'application/json';
  if (init?.session) headers['x-phantom-looper-session'] = init.session;
  const r = await deps.f(`${BASE}${path}`, {
    method: init?.method ?? 'GET', headers,
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  return r.json() as Promise<Envelope>;
}

/** The board handler, at the Cards object — the same rows and refusals the
 *  card routes answer with (they are thin over Cards). `screen` has no
 *  telegram meaning and says so. Every write lands on the board bus, so the
 *  looper and the archive auto-push run exactly as for any other door. */
function boardHandler(deps: AssistantDeps, workspaceId: () => string | null) {
  const cardOf = (c: CardRow) => ({ card: c.number, title: c.title, status: c.status });
  return async (args: KanbanArgs): Promise<unknown> => {
    const ws = workspaceId();
    if (!ws) return { error: 'no active workspace — /workspaces to pick one' };
    const w = await deps.workspaces.get(ws);
    if (!w) return { error: `workspace ${ws} is gone — /workspaces to pick another` };
    try {
      switch (args.action) {
        case 'screen':
          return { note: 'no screen on telegram — read the card instead' };
        case 'list':
          return { prefix: await deps.workspaces.prefixOf(w), cards: (await deps.cards.list(w, {})).map(cardOf) };
        case 'read':
          return (await deps.cards.byNumber(w, args.card!)) ?? { error: `no card ${args.card}` };
        case 'create': {
          const body: Record<string, unknown> = { title: args.title };
          for (const k of ['details', 'status'] as const) if (args[k] !== undefined) body[k] = args[k];
          if (args.requirements) body.requirements = args.requirements;
          return deps.cards.create(w, body as CardFields & { title: string }, CLIENT_ID);
        }
        case 'update': case 'move': {
          const body: Record<string, unknown> = {};
          for (const k of ['title', 'details', 'status', 'blocked_reason',
            'archived', 'auto_plan', 'auto_build', 'pinned'] as const) {
            if (args[k] !== undefined) body[k] = args[k];
          }
          return (await deps.cards.update(w, args.card!, body as CardFields, undefined, CLIENT_ID)).card;
        }
        case 'items':
          return (await deps.cards.update(w, args.card!, {}, args.ops as ItemOp[], CLIENT_ID)).card;
        case 'history':
          return { card: args.card, revisions: await deps.cards.revisions(w, args.card!, 20) };
        default:
          return { error: `unknown board action: ${args.action}` };
      }
    } catch (e) { return { error: (e as Error).message }; }
  };
}

/** What the engine supplies for a turn: where it is, and the two things only
 *  the engine can do — enter a session, and ask the user a yes/no question. */
export interface AssistantCtx {
  /** The assistant's config on ITS ROW's model — Settings.agentConfig('assistant', { pin: sessionPin(own) }). */
  config: AgentConfig;
  workspaceId: () => string | null;
  activeSession: () => string | null;
  /** session_switch fired — the caller enters code mode. */
  onSwitch: (id: string) => Promise<unknown>;
  /** The approval gate: show the ask, resolve with the user's answer; the
   *  tool's abort declines. */
  approve: (ask: { label: string; subject: string }, signal?: AbortSignal) => Promise<boolean>;
  /** A workspace was just created — make it the active one and open a session
   *  in it (the telegram meaning of the cli's "on screen"). */
  onWorkspaceCreated: (workspaceId: string) => Promise<{ session?: string; error?: string }>;
}

/** This bot as an AssistantHost (core/llm/tools/assistantHandlers.ts — the
 *  same handlers the cli's pane answers with). The API is this server's own
 *  surface over `deps.f`; the pointer, the switch and the yes/no are the
 *  engine's. No local turns (`busy`) and no held history: the bot holds no
 *  session in memory, so a read is always the record. */
function telegramHost(deps: AssistantDeps, ctx: AssistantCtx): AssistantHost {
  const call: ApiCall = async (method, path, body) => {
    const j = await api(deps, path, { method, body });
    if (!j.ok) throw new Error(j.error?.message ?? `${method} ${path} failed`);
    return j.data;
  };
  const gitCfg = (sessionId: string) => ({ baseUrl: BASE, apiKey: deps.apiKey, sessionId, fetch: deps.f });
  return {
    call,
    clientId: CLIENT_ID,
    autoPush: (id, onStep) => autoPushSession(gitCfg(id), onStep),
    autoPull: (id, onStep) => autoPullSession(gitCfg(id), onStep),
    workspaceId: ctx.workspaceId,
    activeSession: ctx.activeSession,
    onSwitch: ctx.onSwitch,
    approve: ctx.approve,
    onWorkspaceCreated: ctx.onWorkspaceCreated,
  };
}

/** The Assistant's whole kit for a telegram turn. File tools + web bind to
 *  the assistant's OWN session — the server opens its folder, the on-screen
 *  session's, re-pointed on every switch (Sessions.follow) — when it has one
 *  (read-only); the cron kit to the active workspace when there is one and
 *  its crons are switched on;
 *  board + sessions + the gated workspace_create_repo + git_auto_push +
 *  git_auto_pull + docker_logs always. */
export async function assistantKit(deps: AssistantDeps, ctx: AssistantCtx, own: SessionRow): Promise<Record<string, Tool>> {
  const host = telegramHost(deps, ctx);
  const git = gitHandlers(host);
  const kit: Record<string, Tool> = {
    ...assistantKanbanTool(boardHandler(deps, ctx.workspaceId)),
    ...sessionsTool(sessionsHandler(host)),
    ...workspaceCreateTool(workspaceCreateHandler(host)),
    ...gitAutoPushTool(git.push),
    ...gitAutoPullTool(git.pull),
    ...dockerLogsTool(dockerLogsHandler(host)),
  };
  // Tools that exist in the shared kit but do nothing on Telegram — remove
  // them so the model never wastes a call on a dead end.
  delete kit.kanban_screen;
  delete kit.session_close;
  if (own.folderId) {
    const common = { baseUrl: BASE, apiKey: deps.apiKey, sessionId: own.id, fetch: deps.f };
    Object.assign(kit,
      await phantomTools({ ...common, pick: 'readonly' }),
      webTools(common));
  }
  const ws = ctx.workspaceId();
  if (ws) Object.assign(kit, await cronTools({ baseUrl: BASE, apiKey: deps.apiKey, workspaceId: ws, fetch: deps.f }));
  return kit;
}

/** The result of one assistant turn — the reply text, the text as the sink
 *  sent it (files cut out — what to speak), and the token usage across all
 *  steps (the compaction trigger reads the input size). */
export interface AssistantTurnResult {
  text: string;
  said: string;
  usage: { input: number; output: number; cache_read: number; cache_write: number };
}

/** Run ONE Assistant turn on the conversation, streaming to the telegram
 *  sink. Appends the user + reply to `history` (and to `transcript`, the
 *  on-disk record, when given). Returns the reply text and the turn's
 *  accumulated token usage. `onSwitch` is called if the Assistant's
 *  session_switch fires — the caller moves the active-session pointer.
 *  `own` is the assistant's session row: like every session it runs on ITS
 *  ROW's model (the pin, frozen after its first turn), and its file tools
 *  open its folder. */
export async function runAssistantTurn(
  deps: AssistantDeps, history: ModelMessage[], message: string, sink: TelegramSink,
  ctx: AssistantCtx, abortSignal: AbortSignal | undefined, transcript: Transcript | undefined,
  own: SessionRow,
): Promise<AssistantTurnResult> {
  const tools = await assistantKit(deps, ctx, own);
  const agent = new AssistantAgent({ ...ctx.config.model, fetch: deps.modelFetch }, tools,
    { sessionId: own.id, maxSteps: ctx.config.maxSteps, clock: agentClock(ctx.config) });

  // Accumulate usage across all steps in this turn.
  const usage = { input: 0, output: 0, cache_read: 0, cache_write: 0 };

  // The user message is NOT added to history until the turn succeeds — a
  // failed turn (prompt too long, auth error, anything) never touches the
  // stored conversation. The model sees it in the messages copy below.
  const user: ModelMessage = { role: 'user', content: message };
  let text = '';
  try {
    // A COPY with the user message appended: compaction may splice the
    // stored history mid-turn, and the turn in flight must finish on the
    // conversation it started with — also the warm cached prefix.
    // The `record` seam writes each step's messages AND its usage line to the
    // transcript — the same per-step recording the voice assistant and coding
    // sessions use. No step is lost, no usage is missed.
    const messages = [...history, user];
    const r = await agent.stream({
      messages, abortSignal,
      record: transcript ? {
        appendStep: (msgs, u) => {
          transcript.appendStep(msgs, u);
          const ev = usageEvent(u);
          usage.input += ev.input as number;
          usage.output += ev.output as number;
          usage.cache_read += ev.cache_read as number;
          usage.cache_write += ev.cache_write as number;
        },
      } : undefined,
    });
    let failure: unknown;
    for await (const part of r.stream) {
      const p = part as Record<string, unknown>;
      if (p.type === 'error' && failure === undefined) failure = p.error;
      if (p.type === 'text-delta' && typeof p.text === 'string') text += p.text;
      sink.part(p);
    }
    if (failure !== undefined) {
      // The SDK's r.response rejects with a generic "No output generated" —
      // the real reason is in the error part. Throw it so the caller sees it.
      Promise.resolve(r.response).catch(() => {});
      throw failure instanceof Error ? failure : new Error(String(failure));
    }
    const resp = await r.response;
    // Success: commit the user message and the turn's response to history.
    history.push(user, ...(resp.messages as ModelMessage[]));
    transcript?.append(user);
  } catch (e) {
    // History is untouched — the user message was never added.
    await sink.dispose();
    throw e;
  }
  const said = await sink.done(text);
  return { text, said, usage };
}
