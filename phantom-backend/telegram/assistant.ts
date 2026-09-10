// The Assistant, server-side, for Telegram — assistant MODE, the home the bot
// answers in by default. It is the SAME agent as the cli's side pane
// (core assistantAgent: same prompt, same assistant_* provider/model cascade,
// reasoning pinned none, maxSteps 10) — reached over the webhook instead of the
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
// sessions); the file tools + web are bound to the account's active session,
// so "what does the auth code look like?" works from home. session_switch
// moves that pointer and nothing else — the Assistant keeps the conversation.
// It never SENDS into a session — /code (code mode) is how you talk to a coder.

import type { ModelMessage, Tool } from 'ai';
import { assistantAgent } from '../../core/llm/agents/assistant.js';
import { agentModelConfig, agentMaxSteps } from '../../core/llm/agentConfig.js';
import { assistantKanbanTool, sessionsTool, workspaceCreateTool, gitAutoPushTool, gitAutoPullTool, renderRead, kebabName,
  type KanbanArgs, type SessionsArgs, type WorkspaceCreateArgs, type GitAutoPushArgs, type GitAutoPullArgs } from '../../core/llm/tools/tui.js';
import { autoPushSession, autoPullSession } from '../../core/llm/tools/git.js';
import { phantomTools } from '../../core/llm/tools/workspace.js';
import { webTools } from '../../core/llm/tools/web.js';
import { parseTranscript, type Transcript } from '../../core/llm/transcript.js';
import type { TelegramSink } from './sink.js';

const BASE = 'http://looper';

export interface AssistantDeps {
  f: typeof fetch;
  apiKey: string;
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

/** Map a card number to its row id via the board list — the PATCH/move/items
 *  routes take the row id, reads and creates take the number. */
async function cardIdOf(deps: AssistantDeps, workspaceId: string, seq: number): Promise<number | null> {
  const j = await api(deps, `/workspaces/${workspaceId}/cards?archived=true`);
  if (!j.ok) return null;
  const card = (j.data.cards as Array<{ id: number; seq: number }>).find((c) => c.seq === seq);
  return card?.id ?? null;
}

/** The headless board handler — the same KanbanArgs the app's handler takes,
 *  answered over the card routes instead of a BoardStore. `screen` has no
 *  telegram meaning and says so. */
function boardHandler(deps: AssistantDeps, workspaceId: () => string | null) {
  return async (args: KanbanArgs): Promise<unknown> => {
    const ws = workspaceId();
    if (!ws) return { error: 'no active workspace — /workspaces to pick one' };
    switch (args.action) {
      case 'screen':
        return { note: 'no screen on telegram — read the card instead' };
      case 'list': {
        const j = await api(deps, `/workspaces/${ws}/cards`);
        if (!j.ok) return { error: j.error?.message };
        return {
          prefix: j.data.prefix,
          cards: (j.data.cards as Array<{ seq: number; title: string; status: string }>)
            .map((c) => ({ card: c.seq, title: c.title, status: c.status })),
        };
      }
      case 'read': {
        const j = await api(deps, `/workspaces/${ws}/cards?seq=${args.card}`);
        if (!j.ok) return { error: j.error?.message };
        const c = j.data.cards[0];
        return c ?? { error: `no card ${args.card}` };
      }
      case 'create': {
        const body: Record<string, unknown> = { title: args.title };
        for (const k of ['details', 'status'] as const) if (args[k] !== undefined) body[k] = args[k];
        if (args.requirements) body.requirements = args.requirements;
        const j = await api(deps, `/workspaces/${ws}/cards`, { method: 'POST', body });
        return j.ok ? j.data.card : { error: j.error?.message };
      }
      case 'update': case 'move': {
        const id = await cardIdOf(deps, ws, args.card!);
        if (id == null) return { error: `no card ${args.card}` };
        const body: Record<string, unknown> = {};
        for (const k of ['title', 'details', 'status', 'blocked_reason',
          'archived', 'auto_plan', 'auto_build', 'pinned'] as const) {
          if (args[k] !== undefined) body[k] = args[k];
        }
        const j = await api(deps, `/workspaces/${ws}/cards/${id}`, { method: 'PATCH', body });
        return j.ok ? j.data.card : { error: j.error?.message };
      }
      case 'items': {
        const id = await cardIdOf(deps, ws, args.card!);
        if (id == null) return { error: `no card ${args.card}` };
        const j = await api(deps, `/workspaces/${ws}/cards/${id}`, { method: 'PATCH', body: { items: args.ops } });
        return j.ok ? j.data.card : { error: j.error?.message };
      }
      case 'history': {
        const j = await api(deps, `/workspaces/${ws}/revisions?card=${args.card}`);
        return j.ok ? j.data : { error: j.error?.message };
      }
      default:
        return { error: `unknown board action: ${args.action}` };
    }
  };
}

/** The sessions handler. LIST is the server's list (typed, no supervisor
 *  seats); READ pulls a transcript and renders it; SWITCH is what the caller
 *  wires to "point the account at this session" (the pointer only — never a
 *  mode change); GET_ACTIVE is that pointer; close has no telegram job here. */
function sessionsHandler(
  deps: AssistantDeps, activeSession: () => string | null,
  onSwitch: (id: string) => Promise<unknown>,
) {
  return async (args: SessionsArgs): Promise<unknown> => {
    switch (args.action) {
      case 'list': {
        const limit = args.limit ?? 30;
        const offset = args.offset ?? 0;
        const j = await api(deps, `/sessions?typed=true&supervisor=false&limit=${limit + offset}`);
        if (!j.ok) return { error: j.error?.message };
        const rows = (j.data.sessions as Array<Record<string, unknown>>).slice(offset, offset + limit);
        return {
          sessions: rows.map((s) => ({
            id: s.id, title: s.name ?? null, workspace: s.workspaceId, branch: s.branch ?? null,
            card: s.card ?? null, card_status: s.cardStatus ?? null,
            git_status: s.work ?? null, model: s.model ?? null, tokens: s.tokensOutput ?? null,
            last_message: s.lastUserMessage ?? null, running: s.locked ?? false,
          })),
          total: j.data.total,
        };
      }
      case 'get_active': {
        const id = activeSession();
        return id ? { id } : { note: 'no active session — session_switch sets one' };
      }
      case 'read': {
        const id = args.id ?? activeSession();
        if (!id) return { error: 'no session — pass an id' };
        const j = await api(deps, `/sessions/${id}/transcript`);
        if (!j.ok) return { error: j.error?.message };
        const parsed = parseTranscript(String(j.data.data ?? ''));
        return { text: renderRead(id, parsed.messages, { limit: args.limit, offset: args.offset, tools: args.tools }) };
      }
      case 'switch':
        return args.id ? onSwitch(args.id) : { error: 'switch needs an id' };
      default:
        return { note: 'not available on telegram' };
    }
  };
}

/** What the engine supplies for a turn: where it is, and the two things only
 *  the engine can do — enter a session, and ask the user a yes/no question. */
export interface AssistantCtx {
  settings: Record<string, unknown>;
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

/** `workspace_create_repo`, gated: kebab the name, get the user's accept on
 *  the FINAL name (the point of the gate), then the backend does the whole flow
 *  (POST /workspaces create=true: repo, seed, register; always private) and
 *  the engine opens the new workspace. The same steps as the cli's handler. */
function workspaceCreateHandler(deps: AssistantDeps, ctx: AssistantCtx) {
  return async (args: WorkspaceCreateArgs, opts: { abortSignal?: AbortSignal }): Promise<unknown> => {
    const name = kebabName(args.name ?? '');
    if (!name) return { error: 'no usable name — ask for the project name again' };
    const ok = await ctx.approve({ label: 'new private repo', subject: name }, opts.abortSignal);
    if (!ok) {
      return { declined: true, note: 'nothing was created — the user declined (or the turn was cut off). ' +
        'Often the name was misheard: ask what to change before calling again.' };
    }
    const j = await api(deps, '/workspaces', { method: 'POST', body: {
      url: name, create: true, private: true,
      ...(args.description ? { description: args.description } : {}),
    } });
    if (!j.ok) return { error: j.error?.message };
    const w = j.data as { id: string; owner: string; name: string };
    const opened = await ctx.onWorkspaceCreated(w.id);
    return { ok: true, repo: `${w.owner}/${w.name}`, private: true, workspace_id: w.id,
      ...(opened.session ? { entered: 'a new session in the new workspace — the user is now talking to its coding agent' }
        : { note: `workspace created, but no session could be opened: ${opened.error ?? 'unknown'}` }) };
  };
}

/** `git_auto_push` / `git_auto_pull`, headless: the active session unless an
 *  id was given, through core's one client of each git route (this server's
 *  own surface over `deps.f`). Awaited to the end; a refusal is the answer,
 *  never a throw — the Assistant reports it in a sentence. The steps are not
 *  shown here: the Assistant's answer is the one line the person reads (the
 *  slash commands are the door that shows steps). */
function gitAutoPushHandler(deps: AssistantDeps, activeSession: () => string | null) {
  return async (args: GitAutoPushArgs): Promise<unknown> => {
    const id = args.id ?? activeSession();
    if (!id) return { error: 'no active session — /sessions or /new to pick one, or pass an id' };
    try { return { session: id, ...await autoPushSession({ baseUrl: BASE, apiKey: deps.apiKey, sessionId: id, fetch: deps.f }) }; }
    catch (e) { return { session: id, result: 'error', reason: (e as Error).message }; }
  };
}
function gitAutoPullHandler(deps: AssistantDeps, activeSession: () => string | null) {
  return async (args: GitAutoPullArgs): Promise<unknown> => {
    const id = args.id ?? activeSession();
    if (!id) return { error: 'no active session — /sessions or /new to pick one, or pass an id' };
    try { return { session: id, ...await autoPullSession({ baseUrl: BASE, apiKey: deps.apiKey, sessionId: id, fetch: deps.f }) }; }
    catch (e) { return { session: id, result: 'error', reason: (e as Error).message }; }
  };
}

/** The Assistant's whole kit for a telegram turn. File tools + web bind to the
 *  active session when there is one (read-only); board + sessions + the gated
 *  workspace_create_repo + git_auto_push + git_auto_pull always. */
export async function assistantKit(deps: AssistantDeps, ctx: AssistantCtx): Promise<Record<string, Tool>> {
  const { workspaceId, activeSession, onSwitch } = ctx;
  const kit: Record<string, Tool> = {
    ...assistantKanbanTool(boardHandler(deps, workspaceId)),
    ...sessionsTool(sessionsHandler(deps, activeSession, onSwitch)),
    ...workspaceCreateTool(workspaceCreateHandler(deps, ctx)),
    ...gitAutoPushTool(gitAutoPushHandler(deps, activeSession)),
    ...gitAutoPullTool(gitAutoPullHandler(deps, activeSession)),
  };
  const session = activeSession();
  if (session) {
    const common = { baseUrl: BASE, apiKey: deps.apiKey, sessionId: session, fetch: deps.f };
    Object.assign(kit,
      await phantomTools({ ...common, pick: 'readonly' }),
      webTools(common));
  }
  return kit;
}

/** Run ONE Assistant turn on the conversation, streaming to the telegram
 *  sink. Appends the user + reply to `history` (and to `transcript`, the
 *  on-disk record, when given) and returns the reply text. `onSwitch` is
 *  called if the Assistant's session_switch fires — the caller moves the
 *  active-session pointer. */
export async function runAssistantTurn(
  deps: AssistantDeps, history: ModelMessage[], message: string, sink: TelegramSink,
  ctx: AssistantCtx, abortSignal?: AbortSignal, transcript?: Transcript,
): Promise<string> {
  const model = agentModelConfig(ctx.settings, 'assistant');
  const maxSteps = agentMaxSteps(ctx.settings, 'assistant');
  const tools = await assistantKit(deps, ctx);
  const agent = assistantAgent({ ...model, fetch: deps.modelFetch }, tools, { maxSteps });

  // The user message joins the history now; the turn's produced messages
  // (assistant + tool) append after it. Cache marks are createAgent's and ride
  // COPIES — the stored history stays clean, the same rule the coding turn
  // follows.
  const user: ModelMessage = { role: 'user', content: message };
  history.push(user);
  transcript?.append(user);
  let text = '';
  try {
    // A COPY: compaction may swap the stored history mid-turn (its splice
    // keeps appends intact), and the turn in flight must finish on the
    // conversation it started with — also the warm cached prefix.
    const r = await agent.stream({ messages: [...history], abortSignal });
    for await (const part of r.stream) {
      const p = part as Record<string, unknown>;
      if (p.type === 'text-delta' && typeof p.text === 'string') text += p.text;
      sink.part(p);
    }
    const resp = await r.response;
    history.push(...(resp.messages as ModelMessage[]));
    transcript?.appendAll(resp.messages as ModelMessage[]);
  } catch (e) {
    await sink.dispose();
    throw e;
  }
  await sink.done(text);
  return text;
}
