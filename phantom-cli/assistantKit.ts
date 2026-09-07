// What the Assistant can do to this window: list, read, switch and close
// sessions; drive the board and the screen; create a workspace behind the
// approval gate; push and pull. The tool DEFINITIONS live in voice.ts; these
// are the handlers behind them, and every one reads the window live rather
// than closing over a value — the Assistant's agent is built once (voice
// start, a model change) and must not answer with the session that was on
// screen when it was built.
import type { Tool } from 'ai';
import { sessionsTool, assistantKanbanTool, workspaceCreateTool, gitAutoPushTool,
  gitAutoPullTool, screenModeTools, kebabName, renderRead,
  type KanbanArgs, type SessionsArgs, type WorkspaceCreateArgs,
  type GitAutoPushArgs, type GitAutoPullArgs } from './voice.js';
import { isRunning, whoDrives, ago, type SessionInfo, type WorkspaceInfo } from './components/Launcher.js';
import { kanbanOps, resolveColumn } from './kanban.js';
import type { WindowStore } from './window.js';
import type { Api } from './request.js';

/** `session_list`'s page, for the ASSISTANT rather than the screen. 20 is a
 *  spoken answer's worth ("you have four running, and…"); 50 is the ceiling on
 *  one reply. REACH is how far back offset may go: GET /sessions caps `limit`
 *  at 500 and rejects more outright, and the page is taken by asking for
 *  offset+limit rows and dropping the first offset — so offset+limit is the
 *  number that must stay inside the server's cap. */
export const SESSION_PAGE = 50, SESSION_MAX = 100, SESSION_REACH = 500;

/** One line, capped — a session's last message identifies it; the rest of a
 *  pasted essay is noise in a list of twenty. */
const oneLine = (s: string | null | undefined, max = 80): string | null => {
  if (!s) return null;
  const flat = s.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** The workspace names the session tools speak with: a 26-character id cannot
 *  be read aloud. Fetched ONCE, lazily — a window that never opened the
 *  switcher has none — and held here so every caller reads the same cache. */
export class WorkspaceDirectory {
  private rows: WorkspaceInfo[] = [];
  constructor(private api: Api) {}
  /** Fill the cache if it is empty. Safe to await beside another request —
   *  session_list runs it in parallel with its own fetch. */
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

/** The `session_*` family, one handler.
 *
 *  LIST is the SERVER's answer, not this window's. The store only holds the
 *  sessions you opened here — listing from it made the Assistant say "just
 *  one" while the workspace held fifty. The window still supplies the two
 *  facts the server cannot know: which session is on screen, and which is
 *  mid-turn locally.
 *
 *  Paging is offset/limit, matching session_read and kanban_card_history
 *  rather than the cursor /resume uses: the caller is a model, and an offset
 *  is something it can reason about, while a two-field cursor is something it
 *  must copy back perfectly. The page is ONE request — ask for the rows up to
 *  the end of the window (plus the lookahead), drop the first offset, and
 *  never re-sort: the ordering has exactly one home, on the server. */
export function sessionsHandler(win: WindowStore, api: Api, clientId: string,
  workspaces: WorkspaceDirectory) {
  const store = win.sessions;
  return async (args: SessionsArgs): Promise<unknown> => {
    if (args.action === 'list') {
      const limit = Math.min(Math.max(1, Math.trunc(args.limit ?? SESSION_PAGE)), SESSION_MAX);
      const offset = Math.max(0, Math.trunc(args.offset ?? 0));
      // One row past the window is the LOOKAHEAD: it is the difference
      // between "the page came back full" (which cannot tell a full list from
      // one with more behind it) and knowing. Fetched, never shown.
      const want = offset + limit + 1;
      if (want > SESSION_REACH) {
        return { error: `the list reaches ${SESSION_REACH} sessions back; offset + limit must stay inside that`,
          on_screen: store.activeId };
      }
      let rows: SessionInfo[];
      try {
        // The workspace names ride along on the first list, in parallel.
        const [got] = await Promise.all([
          api('GET', `/sessions?limit=${want}`),
          workspaces.ensure(),
        ]);
        // A server that answers something other than a list is a broken
        // server, not a crashed tool: say so and keep the window usable.
        const list = (got as { sessions?: unknown })?.sessions;
        rows = Array.isArray(list) ? list as SessionInfo[] : [];
      } catch (e) {
        return { error: `could not list sessions: ${(e as Error).message}`, on_screen: store.activeId };
      }
      const page = rows.slice(offset, offset + limit);
      const busy = (id: string) => store.get(id)?.busy ?? false;
      return {
        // The header states the slice the way renderRead's does — the model
        // reports where it is instead of implying it saw everything.
        showing: `${page.length} session${page.length === 1 ? '' : 's'}, newest activity first`
          + (offset ? ` (skipping the ${offset} most recent)` : ''),
        // The lookahead row came back, so there is genuinely more behind this
        // page — not "the page was full, who knows".
        more: rows.length > offset + limit,
        // Stated even when that session falls outside the page.
        on_screen: store.activeId,
        sessions: page.map((s) => ({
          id: s.id,
          name: s.name ?? null,
          // The workspace by NAME: a 26-character id cannot be spoken.
          workspace: workspaces.name(s.workspaceId),
          card: s.card ?? null,
          // Who drives it — the launcher's own three-way. Supervisor rows are
          // MARKED, not hidden: the looper mints one per card, and a list that
          // silently drops half of itself is a list that lies.
          kind: whoDrives(s),
          status: s.status === 'active' ? 'active' : 'ended',
          running: isRunning(s, { busy, clientId }),
          on_screen: s.id === store.activeId,
          git_status: s.work ?? null,
          last_message: oneLine(s.lastUserMessage),
          when: ago(s.lastUsedAt),
        })),
      };
    }
    if (args.action === 'get_active') {
      // The window knows WHICH session is on screen — nothing else can. What
      // identifies it to a person (title, card) lives on the row, so this is
      // one GET for that session alone. Mode is deliberately absent:
      // session_get_mode answers that, and one field with two homes drifts.
      const id = store.activeId;
      const e = id ? store.get(id) : undefined;
      if (!e) return { error: 'no session is on screen' };
      try {
        const [row] = await Promise.all([
          api('GET', `/sessions/${id}`) as Promise<{ name?: string | null; card?: number | null; status?: string }>,
          workspaces.ensure(),
        ]);
        return { id, title: row?.name ?? null, workspace: workspaces.name(e.workspaceId),
          card: row?.card ?? null, status: row?.status === 'active' ? 'active' : 'ended',
          running: e.busy };
      } catch (err) {
        // The server is out of reach; which session is on screen is still this
        // window's own fact, so answer it and say what is missing.
        return { id, workspace: workspaces.name(e.workspaceId), running: e.busy,
          note: `could not read the session row (${(err as Error).message}) — title and card unavailable` };
      }
    }
    if (args.action === 'switch') {
      // ONE open path, always — openSession decides whether the session is
      // already here, needs attaching, or (having been swept) needs
      // restarting. No partial-id matching: that took the FIRST session whose
      // id started with the argument, so an ambiguous prefix silently landed
      // on the wrong conversation. Ids come from session_list in the same
      // breath; exact is the whole story.
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'session_switch needs an id — session_list has them' };
      const ok = await win.openSession({ kind: 'open', id });
      if (!ok) {
        return { error: `could not open session ${id} — check the id against session_list; ` +
          'the conversation pane says what went wrong' };
      }
      return { ok: true, on_screen: store.activeId };
    }
    if (args.action === 'close') {
      // The app's one close path; its result is already the answer — what
      // closed, what is on screen now, whether a fresh session had to open.
      return win.closeSession(args.id ? String(args.id).trim() : undefined);
    }
    if (args.action === 'read') {
      // No id = the session on screen; the store's history is the transcript.
      // Only what is OPEN here can be read — switch is what opens one, and the
      // error names that step rather than implying the id was wrong.
      const id = args.id ? String(args.id) : store.activeId;
      const e = id ? store.get(id) : undefined;
      if (!e) {
        return { error: `session ${id || '(none on screen)'} is not open in this window — ` +
          'session_switch opens it, then read it' };
      }
      return renderRead(e.id, e.history, args);
    }
    return { error: `unknown action ${String(args.action)}` };
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
      if (args.show === 'off') { win.setView('chat'); return { ok: true, screen: 'chat' }; }
      const b = win.boardFor(workspaceId);
      if (!b.state.loaded) await b.load();
      if (args.show === 'column') {
        // One column across the whole width — the board's [e]. Spoken names
        // are forgiven the way a move's are; the Board consumes the request
        // once it is up (from chat it comes up first).
        if (args.column === undefined) return { error: 'show column needs the column name' };
        const col = resolveColumn(b, args.column);
        if (!col) return { error: `no column "${args.column}" — the columns are: ${b.state.columns.join(', ')}` };
        win.setView('board');
        b.requestColumn(col);
        return { ok: true, screen: `column ${col}, expanded` };
      }
      if (args.show === 'card') {
        const up = win.view === 'board';
        if (args.card === undefined) return { error: 'show card needs the card number', screen: up ? 'board' : 'chat' };
        if (!b.bySeq(args.card)) return { error: `no card ${args.card}`, screen: up ? 'board' : 'chat' };
        // Where esc will go is decided HERE, once: back to the columns when
        // the board was already up, back to the chat when it was not.
        win.openCard(args.card, up ? 'board' : 'chat');
        return { ok: true, screen: up ? `card ${args.card}, on the board` : `card ${args.card}` };
      }
      win.setView('board');
      b.requestBoard(); // every column: an open editor drops, an expanded column collapses
      return { ok: true, screen: 'board' };
    }
    return kanbanOps(win.boardFor(workspaceId), args);
  };
}

/** `workspace_create_repo`: kebab the name, get the user's accept (the ask
 *  shows the FINAL name — the point of the gate), then the backend does the
 *  whole flow (POST /workspaces create=true: repo, seed, register; always
 *  private, not the model's call) and the new workspace opens as a session on
 *  screen, the same join+switch every open uses. */
export function workspaceCreateHandler(win: WindowStore, api: Api) {
  return async (args: WorkspaceCreateArgs, opts: { abortSignal?: AbortSignal }): Promise<unknown> => {
    const name = kebabName(args.name ?? '');
    if (!name) return { error: 'no usable name — ask for the project name again' };
    if (win.approval) return { error: 'another approval is already waiting on screen' };
    const ok = await win.requestApproval({ label: 'new private repo', subject: name }, opts.abortSignal);
    if (!ok) {
      return { declined: true, note: 'nothing was created — the user declined (or the turn was cut off). ' +
        'Often the name was misheard: ask what to change before calling again.' };
    }
    try {
      const w = await api('POST', '/workspaces', {
        url: name, create: true, private: true,
        ...(args.description ? { description: args.description } : {}),
      }) as { id: string; owner: string; name: string };
      const opened = await win.openSession({ kind: 'new', workspaceId: w.id });
      return { ok: true, repo: `${w.owner}/${w.name}`, private: true, workspace_id: w.id,
        on_screen: opened ? 'a new session in the new workspace'
          : 'workspace created, but the session could not be opened — the conversation pane says why' };
    } catch (e) { return { error: (e as Error).message }; }
  };
}

/** `git_auto_push` and `git_auto_pull`: the session on screen unless an id was
 *  given, awaited to the end so the Assistant can say how it went. The work
 *  itself is the window's — `/auto-push` is the same path. */
export function gitHandlers(win: WindowStore) {
  return {
    push: async (args: GitAutoPushArgs) => {
      const id = args.id ?? win.sessions.activeId;
      if (!id) return { error: 'no session is open — nothing to push' };
      return { session: id, ...await win.runAutoPush(id) };
    },
    pull: async (args: GitAutoPullArgs) => {
      const id = args.id ?? win.sessions.activeId;
      if (!id) return { error: 'no session is open — nothing to pull into' };
      return { session: id, ...await win.runAutoPull(id) };
    },
  };
}

/** The Assistant's whole kit: the tools the window answers, plus the read-only
 *  workspace tools scoped to the session ON SCREEN. Rebuilt (setAgent — the
 *  history is kept) when that session changes; a failed fetch just means no
 *  file tools. The ORDER is part of the kit: two tests read the key list. */
export async function buildAssistantKit(win: WindowStore, deps: {
  api: Api;
  clientId: string;
  workspaces: WorkspaceDirectory;
  newAssistantTools: (sessionId: string) => Promise<Record<string, Tool>>;
}): Promise<Record<string, Tool>> {
  const git = gitHandlers(win);
  const sessionId = win.sessions.activeId;
  return {
    ...sessionsTool(sessionsHandler(win, deps.api, deps.clientId, deps.workspaces)),
    ...assistantKanbanTool(kanbanHandler(win)),
    ...workspaceCreateTool(workspaceCreateHandler(win, deps.api)),
    ...gitAutoPushTool(git.push),
    ...gitAutoPullTool(git.pull),
    ...screenModeTools(win.screenOps()),
    ...(sessionId ? await deps.newAssistantTools(sessionId).catch(() => ({} as Record<string, Tool>)) : {}),
  };
}
