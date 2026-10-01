// What the Assistant can do to this window. The tool DEFINITIONS live in
// tui.ts (re-exported by voice.ts); the HANDLERS are core's one set
// (core/llm/tools/assistantHandlers.ts — the same code the Telegram bot
// answers with). This file supplies what only the window knows — which
// session is on screen, how to open one, the approval pane, the local turns
// — and the two handlers that ARE the window's: the board (its live
// BoardStore, and moving the screen) and screen mode.
import type { Tool } from 'ai';
import type { ToolKit } from 'phantom-client-sdk';
import { sessionsTool, assistantKanbanTool, workspaceCreateTool, gitAutoPushTool,
  gitAutoPullTool, assistantModeTool, dockerLogsTool, type KanbanArgs } from './voice.js';
import { sessionsHandler, workspaceCreateHandler, gitHandlers, dockerLogsHandler,
  type AssistantHost } from '../core/llm/tools/assistantHandlers.js';
import type { WorkspaceInfo } from './components/Launcher.js';
import { kanbanOps, resolveColumn } from './kanban.js';
import type { WindowStore } from './window.js';
import type { Api } from './request.js';

/** The workspace names the session tools speak with: a 26-character id cannot
 *  be read aloud. Fetched ONCE, lazily — a window that never opened the
 *  switcher has none — and held here so every caller reads the same cache. */
export class WorkspaceDirectory {
  private rows: WorkspaceInfo[] = [];
  constructor(private api: Api) {}
  /** Fill the cache if it is empty. */
  async ensure(): Promise<void> {
    if (this.rows.length) return;
    const ws = await this.api('GET', '/workspaces');
    if (Array.isArray(ws) && ws.length) this.rows = ws as WorkspaceInfo[];
  }
  /** A list another screen already fetched (the switcher's). Only a NON-empty
   *  list is taken: an empty render must not wipe what we have. */
  offer(rows: WorkspaceInfo[]): void { if (rows.length) this.rows = rows; }
  /** The name to say for a workspace id — the id itself when unknown, which
   *  is still an answer rather than a blank. */
  name(id: string): string {
    const w = this.rows.find((n) => n.id === id);
    return w?.displayName || w?.name || id;
  }
}

/** The window as an AssistantHost: every fact read LIVE off the window, never
 *  closed over — the agent is built once (voice start, a model change) and
 *  must not answer with the session that was on screen when it was built. */
export function windowHost(win: WindowStore, deps: {
  api: Api; clientId: string; workspaces: WorkspaceDirectory;
}): AssistantHost {
  const store = win.sessions;
  return {
    call: deps.api,
    clientId: deps.clientId,
    // The window's one push/pull path — /auto-push is the same door, and
    // every step lands as a note in the session's pane.
    autoPush: (id) => win.runAutoPush(id),
    autoPull: (id) => win.runAutoPull(id),
    workspaceId: () => store.active()?.workspaceId ?? null,
    activeSession: () => store.activeId || null,
    busy: (id) => store.get(id)?.busy ?? false,
    history: (id) => { const h = store.get(id)?.history; return h ? [...h] : null; },
    // ONE open path — openSession decides whether the session is already
    // here, needs attaching, or (swept) needs restarting. Then the chat view:
    // the builder sees the session regardless of which screen was up.
    onSwitch: async (id) => {
      const ok = await win.openSession({ kind: 'open', id });
      if (!ok) {
        return { error: `could not open session ${id} — check the id against session_list; ` +
          'the conversation pane says what went wrong' };
      }
      win.dismissOverlay();
      return { ok: true, on_screen: store.activeId };
    },
    // The app's one close path; its result is already the answer.
    onClose: (id) => win.closeSession(id),
    approve: (ask, signal) => {
      if (win.approval) return Promise.resolve(false);
      return win.requestApproval(ask, signal);
    },
    onWorkspaceCreated: async (workspaceId) => {
      const opened = await win.openSession({ kind: 'new', workspaceId });
      return opened ? { session: store.activeId } : { error: 'the conversation pane says why' };
    },
  };
}

/** The board, plus the one thing the coding agent's handler cannot do: move
 *  the screen. `kanban_screen` walks chat → board → column / card, and the
 *  result names the level now on screen so the Assistant reports it instead of
 *  guessing. Everything else is the shared card work in kanban.ts. */
export function kanbanHandler(win: WindowStore) {
  return async (args: KanbanArgs): Promise<unknown> => {
    const workspaceId = win.sessions.active()?.workspaceId ?? '';
    if (!workspaceId) return { error: 'no session is on screen yet, so there is no workspace or board' };
    if (args.action === 'screen') {
      if (args.show === 'off') { win.dismissOverlay(); return { ok: true, screen: 'chat' }; }
      const b = win.boardFor(workspaceId);
      if (!b.state.loaded) await b.load();
      if (args.show === 'column') {
        // One column across the whole width — the board's [e]. Spoken names
        // are forgiven the way a move's are; the Board consumes the request
        // once it is up (from chat it comes up first).
        if (args.column === undefined) return { error: 'show column needs the column name' };
        const col = resolveColumn(b, args.column);
        if (!col) return { error: `no column "${args.column}" — the columns are: ${b.state.columns.join(', ')}` };
        win.openBoard();
        b.requestColumn(col);
        return { ok: true, screen: `column ${col}, expanded` };
      }
      if (args.show === 'card') {
        const up = win.boardUp;
        if (args.card === undefined) return { error: 'show card needs the card number', screen: up ? 'board' : 'chat' };
        if (!b.byNumber(args.card)) return { error: `no card ${args.card}`, screen: up ? 'board' : 'chat' };
        // Where esc will go is decided HERE, once: back to the columns when
        // the board was already up, back to the chat when it was not.
        win.openCard(args.card, up ? 'board' : 'chat');
        return { ok: true, screen: up ? `card ${args.card}, on the board` : `card ${args.card}` };
      }
      win.openBoard();
      b.requestBoard(); // every column: an open editor drops, an expanded column collapses
      return { ok: true, screen: 'board' };
    }
    return kanbanOps(win.boardFor(workspaceId), args);
  };
}

/** The Assistant's tools only this window can serve: core's handlers over
 *  this window as host, the window's own two (board, screen mode). The
 *  server's tools for the assistant (the read-only workspace tools, web,
 *  crons…) come with every turn start and ride beside these. Every fact is
 *  read live off the window at execute time, so one kit serves every
 *  session that comes on screen. `mutating` names the ones plan mode
 *  refuses — the Assistant's session is never in plan mode, so none. */
export function assistantToolKit(win: WindowStore, deps: {
  api: Api;
  clientId: string;
  workspaces: WorkspaceDirectory;
}): ToolKit {
  const host = windowHost(win, deps);
  const git = gitHandlers(host);
  return {
    name: 'cli-assistant',
    build: async () => ({
      tools: {
        ...sessionsTool(sessionsHandler(host)),
        ...assistantKanbanTool(kanbanHandler(win)),
        ...workspaceCreateTool(workspaceCreateHandler(host)),
        ...gitAutoPushTool(git.push),
        ...gitAutoPullTool(git.pull),
        ...assistantModeTool(win.screenOps()),
        ...dockerLogsTool(dockerLogsHandler(host)),
      } as Record<string, Tool>,
      mutating: [],
    }),
  };
}
