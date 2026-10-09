// The Assistant, server-side, for Telegram — assistant MODE, the home the bot
// answers in by default. It is the SAME agent as the cli's side pane
// (phantom-looper/agents/assistant: same prompt, same tools, same handlers) run on the
// client SDK over loopback: its session row is its record, its tools are the
// server's for its type plus this kit — the board, the sessions, the gated
// project_create_repo, git auto-push/pull, docker logs — bound to what only
// the bot knows: the active project, the pointer, the switch, the yes/no.
import type { Tool } from 'ai';
import type { ToolKit, ToolKitContext } from '@phantom-agent-sdk/client';
import { sessionsTool, assistantKanbanTool, projectCreateTool, gitAutoPushTool, gitAutoPullTool, dockerLogsTool,
  type KanbanArgs } from '../../phantom-looper/agents/assistant/tools.js';
import { sessionsHandler, projectCreateHandler, gitHandlers, dockerLogsHandler,
  type AssistantHost } from '../../phantom-looper/agents/assistant/handlers.js';
import { autoPushSession, autoPullSession } from '../../phantom-looper/agents/assistant/gitSteps.js';
import type { Cards, Projects, CardFields, ItemOp } from '@phantom-agent-sdk/backend';
import type { CardRow } from '@phantom-agent-sdk/backend/schema';

export const CLIENT_ID = 'telegram';
/** Telegram as an actor — what its sessions record as started_by and last_turn_by. */
export const TELEGRAM_STARTER = 'telegram';

export interface AssistantDeps {
  /** The board's owner, and the project rows it is addressed by. */
  cards: Cards;
  projects: Projects;
  /** Where this process reaches its own API (the git streams). */
  loopback: { url: string; serviceRoleKey: string };
}

/** The board handler, at the Cards object — the same rows and refusals the
 *  card routes answer with (they are thin over Cards). `screen` has no
 *  telegram meaning and says so. Every write lands on the board bus, so the
 *  card runs and the archive auto-push run exactly as for any other door. */
function boardHandler(deps: AssistantDeps, projectId: () => string | null) {
  const cardOf = (card: CardRow) => ({ card: card.number, title: card.title, status: card.status });
  // Card rows carry Date fields. Every other door serializes them over HTTP;
  // here the row would go into the model's history as-is, and the SDK
  // rejects a non-JSON tool result on the NEXT turn. The same round-trip the API does.
  const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
  return async (args: KanbanArgs): Promise<unknown> => json(await handle(args));
  async function handle(args: KanbanArgs): Promise<unknown> {
    const id = projectId();
    if (!id) return { error: 'no active project — /projects to pick one' };
    const project = await deps.projects.get(id);
    if (!project) return { error: `project ${id} is gone — /projects to pick another` };
    try {
      switch (args.action) {
        case 'screen':
          return { note: 'no screen on telegram — read the card instead' };
        case 'list':
          return { prefix: await deps.projects.prefixOf(project), cards: (await deps.cards.list(project, {})).map(cardOf) };
        case 'read':
          return (await deps.cards.byNumber(project, args.card!)) ?? { error: `no card ${args.card}` };
        case 'create': {
          const body: Record<string, unknown> = { title: args.title };
          for (const field of ['details', 'status'] as const) if (args[field] !== undefined) body[field] = args[field];
          if (args.requirements) body.requirements = args.requirements;
          return deps.cards.create(project, body as CardFields & { title: string }, CLIENT_ID);
        }
        case 'update': case 'move': {
          const body: Record<string, unknown> = {};
          for (const field of ['title', 'details', 'status', 'blocked_reason',
            'archived', 'auto_plan', 'auto_build', 'pinned'] as const) {
            if (args[field] !== undefined) body[field] = args[field];
          }
          return (await deps.cards.update(project, args.card!, body as CardFields, undefined, CLIENT_ID)).card;
        }
        case 'items':
          return (await deps.cards.update(project, args.card!, {}, args.ops as ItemOp[], CLIENT_ID)).card;
        case 'history':
          return { card: args.card, revisions: await deps.cards.revisions(project, args.card!, 20) };
        default:
          return { error: `unknown board action: ${args.action}` };
      }
    } catch (error) { return { error: (error as Error).message }; }
  }
}

/** What the bot supplies for a turn: where it is, and the things only the
 *  bot can do — enter a session, make a new project active, ask a yes/no. */
export interface AssistantCtx {
  projectId: () => string | null;
  activeSession: () => string | null;
  /** session_switch fired — the caller moves the pointer. */
  onSwitch: (id: string) => Promise<unknown>;
  /** The approval gate: show the ask, resolve with the user's answer; the tool's abort declines. */
  approve: (ask: { label: string; subject: string }, signal?: AbortSignal) => Promise<boolean>;
  /** A project was just created — make it the active one and open a session in it. */
  onProjectCreated: (projectId: string) => Promise<{ session?: string; error?: string }>;
}

/** This bot as an AssistantHost (phantom-looper/agents/assistant/handlers — the same
 *  handlers the cli's pane answers with). The API is reached through the
 *  agent's own client; the pointer, the switch and the yes/no are the bot's.
 *  No local turns (`busy`) and no held history: the bot holds no session in
 *  memory, so a read is always the record. */
function telegramHost(deps: AssistantDeps, ctx: AssistantCtx, kit: ToolKitContext): AssistantHost {
  const gitCfg = (sessionId: string) => ({ baseUrl: deps.loopback.url, serviceRoleKey: deps.loopback.serviceRoleKey, sessionId });
  return {
    call: (method, path, body) => kit.backend.call(method, path, body),
    clientId: CLIENT_ID,
    autoPush: (id, onStep) => autoPushSession(gitCfg(id), onStep),
    autoPull: (id, onStep) => autoPullSession(gitCfg(id), onStep),
    projectId: ctx.projectId,
    activeSession: ctx.activeSession,
    onSwitch: ctx.onSwitch,
    approve: ctx.approve,
    onProjectCreated: ctx.onProjectCreated,
  };
}

/** The Assistant's kit for a telegram turn — what the server's tools for the
 *  assistant type (files, web, crons) do not cover: the board, the sessions,
 *  the gated project_create_repo, git auto-push / auto-pull, docker logs.
 *  Tools that exist in the shared kit but do nothing on Telegram are left out
 *  so the model never wastes a call on a dead end. */
export function telegramAssistantKit(deps: AssistantDeps, ctx: AssistantCtx): ToolKit {
  return {
    name: 'telegram-assistant',
    build(kit) {
      const host = telegramHost(deps, ctx, kit);
      const git = gitHandlers(host);
      const tools: Record<string, Tool> = {
        ...assistantKanbanTool(boardHandler(deps, ctx.projectId)),
        ...sessionsTool(sessionsHandler(host)),
        ...projectCreateTool(projectCreateHandler(host)),
        ...gitAutoPushTool(git.push),
        ...gitAutoPullTool(git.pull),
        ...dockerLogsTool(dockerLogsHandler(host)),
      };
      delete tools.kanban_screen;
      delete tools.session_close;
      return Promise.resolve({ tools, mutating: [] });
    },
  };
}
