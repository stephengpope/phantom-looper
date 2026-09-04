// Layout: the whole terminal, drawn live (alternate screen — index.tsx). A row
// of two panes: the conversation on the left, the Assistant on the right
// (ctrl+g shows and hides it; its width is a setting). Each pane is a `Pane`:
// a clipped viewport anchored at the bottom, scrolled by rows. Under the left
// pane sits the block still being written, the status line, the typing area
// and the toolbar; that block is budgeted in rows (`liveRows`) so the pane
// above it keeps its share of the screen.
//
// Nothing is printed into scrollback any more: there is no <Static>, and
// switching session no longer wipes the terminal — the pane simply shows a
// different list.
//
// A menu (/settings, /model, /workspace, the session switcher) REPLACES the
// typing area rather than floating over it, and while one is open this
// component's own useInput is switched off: Ink delivers a keypress to every
// active handler, so esc would otherwise close the menu and interrupt the
// running turn in the same stroke.
//
// SEVERAL SESSIONS AT ONCE. Every session you open stays open and keeps
// running; this component is a view over whichever one is active. The
// conversations live in `sessions.ts`, outside React, because a turn streaming
// in a session you are not looking at cannot write into component state that
// belongs to the session you are.
//
// Keys: enter submit (queues while a turn runs) · esc interrupt · tab/shift+tab next/previous session ·
// ctrl+n the session list · ↑/↓ what you said before · ctrl+o show more
// (thinking, and a tool's whole command and output) · ctrl+g the voice pane ·
// ctrl+r mic · ctrl+l speaker (both work
// anywhere, the board included) · pageUp/pageDown scroll the conversation ·
// ctrl+c twice to quit.
import { Box, useApp, useBoxMetrics, useInput, useWindowSize } from 'ink';
import { Text } from './components/Text.js';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ModelMessage, Tool } from 'ai';
import { runTurn } from './agent.js';
import { buildAgent, buildAssistantAgent, codingInstructions } from './agentFromConfig.js';
import { messagesToParts, nextId, phaseLabel, tokenCount, type Part } from './state.js';
import { hostname } from 'node:os';
import { Transcript, loadTranscript, lastUserMessage, adoptServerCopy, syncTranscriptUp, type TranscriptHeader } from './session.js';
import { parseTranscript } from '../core/llm/transcript.js';
import { openSession as coreOpenSession } from '../core/session.js';
import { SessionStore, type LoadedSession } from './sessions.js';
import { COMMANDS, complete, matches, parse } from './commands.js';

/** Rows the slash menu shows at once; the window slides to follow the cursor. */
const MENU_ROWS = 8;
import { PartView } from './components/Parts.js';
import { Prompt } from './components/Prompt.js';
import { StatusLine } from './components/StatusLine.js';
import { Toolbar } from './components/Toolbar.js';
import { Settings, type Api } from './components/Settings.js';
import { Launcher, lastWorkspaceId, isRunning, ago, type SessionInfo, type WorkspaceInfo } from './components/Launcher.js';
import { NewWorkspace, type NewWorkspaceRequest } from './components/NewWorkspace.js';
import { WorkspaceSettings } from './components/WorkspaceSettings.js';
import { SessionSwitcher } from './components/SessionSwitcher.js';
import { Keys } from './components/Keys.js';
import { Tasks, type TasksView } from './components/Tasks.js';
import { Archived } from './components/Archived.js';
import { Secrets } from './components/Secrets.js';
import { SizeContext, keyLine } from './components/Screen.js';
import { Pane } from './components/Pane.js';
import { Boundary } from './components/Boundary.js';
import { Banner } from './components/Banner.js';
import { VoicePanel } from './components/VoicePanel.js';
import { Divider } from './components/Divider.js';
import { VoiceClient, sessionsTool, assistantKanbanTool, codingKanbanTool, workspaceCreateTool, screenModeTools, kebabName, renderRead, sidecarEnv, type KanbanArgs, type SessionsArgs, type WorkspaceCreateArgs, type ScreenModeHandler } from './voice.js';
import { BoardStore, type Card, type Stream } from './board.js';
import { SessionFeed } from './sessionFeed.js';
import { Board } from './components/Board.js';
import { VOICE_BOOT_KEYS, ASSISTANT_MODEL_KEYS, REMOTE_DEFAULTS, isLocalKey, type ConfigKey, type ConfigValue } from './config.js';
import { clearLocal, localValues, setLocal } from './local.js';
import { makeSettings, type Settings as SettingsClient } from './settings.js';
import { copyToClipboard, isMouseInput, parseMouse, selectionRanges, type Selection } from './mouse.js';
import type { Screen } from './screen.js';
import { type SkillMeta } from '../core/skills/skills.js';
import { type SecretIndexEntry } from '../core/llm/prompts/coding/wiring.js';
import type { GitFacts } from '../core/llm/prompts/coding/wiring.js';

/** What the window remembers about a workspace: the banner's display name and
 *  the prefix its cards are named with (`PHA` → `PHA-7`). */
interface WsFacts { label: string; cardPrefix?: string }

export interface Initial {
  sessionId: string; branch: string; workspaceId: string;
  /** The workspace's display name for the banner; the id stands in when the
   *  lookup failed — it still identifies the workspace. */
  workspace?: string;
  tools: Record<string, Tool>; resumed: ModelMessage[];
  card?: number | null;
  /** True when this is a supervisor session — a read-only record. */
  readonly?: boolean;
  /** The stored system prompt when resuming (transcript header). Absent — a
   *  new session, or an old transcript — a fresh stack is assembled. */
  instructions?: string;
  /** The skill index for a NEW session's prompt — the create response's repo
   *  scan merged with the personal tier (index.tsx does the merge). Unused on
   *  resume: the frozen prompt wins. */
  skills?: SkillMeta[];
  /** The workspace's git facts for a NEW session's prompt (create response:
   *  agent_git_credentials). Unused on resume, like skills. */
  git?: GitFacts;
}
type Menu = null | 'settings' | 'keys' | 'secrets' | 'model' | 'server' | 'voice' | 'workspace' | 'resume'
  | 'addWorkspace' | 'workspaceSettings' | 'sessions' | 'tasks' | 'archived';

const offline: Api = async () => ({});

/** Each voice switch is a setting — the toggle writes it and onConfigChange
 *  pushes it to the engine, so the state holds across restarts. */
const TOGGLE_KEY: Record<'mic' | 'speaker' | 'headphones' | 'wake', ConfigKey> = {
  mic: 'voice_mic_muted', speaker: 'voice_speaker_muted',
  headphones: 'voice_headphones', wake: 'voice_wake_word',
};

/** The workspace names the session tools speak with: a 26-character id cannot
 *  be read aloud. Fetched ONCE, lazily — a window that never opened the
 *  switcher has none — and held here so every caller (session_list,
 *  session_get_active) reads the same cache instead of keeping its own. */
class WorkspaceDirectory {
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

/** The header for a session, as parts: where you are (workspace · branch —
 *  the branch is agent/<session-id>, so it names the session too), then the
 *  model line. The blank row above it is the pane's (`topGap`), not a part
 *  here: every way the pane can be filled needs it, not just this one. */
function bannerParts(s: { workspace: string; branch: string }, summary: { provider: string; model: string; reasoning: string }): Part[] {
  return [
    `${s.workspace} · ${s.branch}`,
    `${summary.provider}/${summary.model} · reasoning ${summary.reasoning}`,
  ].map((text) => ({ kind: 'note', id: nextId('note'), text }) as Part);
}

/** What a card looks like in a tool result: the line you would read off the
 *  board. `get` returns the whole card instead. */
const cardSummary = (t: Card) =>
  ({ card: t.seq, title: t.title, status: t.status,
    ...(t.pinned ? { pinned: true } : {}),
    ...(t.blocked_reason ? { blocked: t.blocked_reason } : {}) });

/** The summary plus the checklists WITH their keys — what create/update/tick
 *  answer, so the agent copies keys from the result instead of guessing them
 *  from the text (the Assistant has no card read; this is where it sees them). */
const cardWithLists = (t: Card) => ({ ...cardSummary(t),
  ...(t.requirements.length ? { requirements: t.requirements } : {}) });

/** A column name as the agent said it → the board's real column. A voice
 *  transcript says "in progress", never "in_progress", so spaces/hyphens and
 *  case are forgiven; anything else is not a column. */
const resolveColumn = (board: BoardStore, name: string): string | undefined => {
  const want = name.trim().toLowerCase().replace(/[\s_-]+/g, '_');
  return board.state.columns.find((c) => c.toLowerCase() === want);
};

/** The card work both kanban tools do — the Assistant's and the coding
 *  agent's — against one board store. Screen actions (open/close) belong to
 *  the Assistant alone and stay in App; everything that touches a card is
 *  here, once, so the two tools cannot drift apart. Every failure comes back
 *  as { error } — the store reverts a rejected write, so an `ok` here without
 *  checking would report a move that did not happen. */
export async function kanbanOps(board: BoardStore, args: KanbanArgs): Promise<unknown> {
  if (!board.state.loaded) await board.load();
  if (!board.state.columns.length) return { error: `board unavailable: ${board.state.error ?? 'no columns'}` };
  let status = args.status;
  if (status !== undefined) {
    const col = resolveColumn(board, status);
    if (!col) return { error: `no column "${status}" — the columns are: ${board.state.columns.join(', ')}` };
    status = col;
  }
  if (args.action === 'list') {
    return { prefix: board.state.prefix, columns: board.state.columns,
      cards: board.state.columns.flatMap((c) => board.cardsIn(c).map(cardSummary)) };
  }
  if (args.action === 'create') {
    if (!args.title) return { error: 'create needs a title' };
    try {
      const made = await board.create({ title: args.title, status,
        details: args.details, user_story: args.user_story,
        requirements: args.requirements?.map((c) => ({ ...c, done: c.done ?? false })) });
      return { ok: true, ...cardWithLists(made) };
    } catch (e) { return { error: (e as Error).message }; }
  }
  if (args.action === 'history') {
    // By seq straight to the server, not bySeq: a deleted card is not on the
    // board, and reading one that is gone is what history is for.
    if (args.card === undefined) return { error: 'history needs the card number' };
    try { return { card: args.card, revisions: await board.revisions(args.card, args.limit) }; }
    catch (e) { return { error: (e as Error).message }; }
  }
  // The board GET excludes archived cards, so a bySeq miss asks the server
  // for that number directly — "read card 7" / "restore card 7" must work on
  // a card that is off the board. The fetch adopts the card into the store.
  let t = args.card !== undefined ? board.bySeq(args.card) : undefined;
  if (!t && args.card !== undefined) t = await board.fetchCard(args.card).catch(() => undefined);
  if (!t) return { error: `no card ${args.card ?? '(none given)'} — pass the card number` };
  if (args.action === 'read') {
    return { card: t.seq, title: t.title, status: t.status, user_story: t.user_story,
      details: t.details, requirements: t.requirements,
      blocked_reason: t.blocked_reason, archived: t.archived };
  }
  if (args.action === 'move') {
    if (!status) return { error: 'move needs a status (column name)' };
    const failed = await board.move(t.id, status, 1e9);
    if (failed) return { error: failed };
  } else if (args.action === 'items') {
    if (!args.ops?.length) return { error: 'items needs ops: [{op, list, key?, text?, done?}]' };
    const failed = await board.items(t.id, args.ops);
    if (failed) return { error: failed };
  } else {
    const patch: Record<string, unknown> = {};
    for (const f of ['title', 'details', 'user_story', 'blocked_reason', 'auto_plan', 'auto_build', 'pinned', 'archived'] as const)
      if (args[f] !== undefined) patch[f] = args[f];
    if (status !== undefined) patch.status = status;
    if (args.requirements !== undefined)
      patch.requirements = args.requirements.map((c) => ({ ...c, done: c.done ?? false }));
    if (!Object.keys(patch).length) return { error: 'nothing to update' };
    const failed = await board.update(t.id, patch as Parameters<typeof board.update>[1]);
    if (failed) return { error: failed };
  }
  const fresh = board.state.cards.find((x) => x.id === t.id);
  const shape = args.action === 'move' ? cardSummary : cardWithLists;
  // A switch flip answers with the switch as it now stands — the effective
  // value, inherit spelled out — so the tool never has to guess what null means.
  const switchState = (v: boolean | null | undefined, fallback: boolean | undefined) =>
    v == null ? `inherit (workspace ${fallback ? 'on' : 'off'})` : v ? 'on' : 'off';
  const switches = args.auto_plan !== undefined || args.auto_build !== undefined
    ? { auto_plan: switchState(fresh?.auto_plan, board.state.autoPlanDefault),
      auto_build: switchState(fresh?.auto_build, board.state.autoBuildDefault) } : {};
  return { ok: true, ...(fresh ? shape(fresh) : {}), ...switches };
}

/** /resume's page size: what the picker fetches at open and appends per
 *  scroll-to-the-bottom. Comfortably more than a screenful, small enough
 *  that a list of thousands never rides one response. */
export const PICKER_PAGE = 30;

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

export function App({
  api, stream, initial, boot, newTools, configPath, onSession, bootConfig,
  autoPush,
  clientId = '',
  pollMs = 10_000,
  taskPollMs = 60_000,
  makeAgent = buildAgent,
  makeTranscript = (h: TranscriptHeader) => new Transcript(h),
  loadHistory = (id: string) => loadTranscript(id).messages,
  loadPrompt = (id: string) => loadTranscript(id).header?.system_prompt,
  run = runTurn,
  sidebarPercent = 20,
  makeVoice = () => new VoiceClient(undefined, undefined, run),
  makeAssistantAgent = buildAssistantAgent,
  newAssistantTools = async () => ({}),
  screen,
}: {
  api: Api;
  /** GET a server ND-JSON stream as records — each BoardStore follows its
   *  workspace's `/events` through it. index.tsx wires the real one; absent
   *  (tests), boards load once and hear nothing. */
  stream?: Stream;
  /** POST /git/auto-push for one session, consuming its ND-JSON stream: `onStep`
   *  gets a human label per step, the promise resolves with the final result.
   *  index.tsx wires the real one; absent in tests, /auto-push says so. */
  autoPush?: (sessionId: string, onStep?: (label: string) => void) =>
    Promise<{ result: string; reason?: string; sha?: string }>;
  /** This window's session-lock id (index.tsx mints one per process and sends
   *  it as x-phantom-looper-client). The launcher uses it so this window's own held
   *  sessions do not read "in use". Empty in tests. */
  clientId?: string;
  /** How often the session on screen, while idle in this window, is checked
   *  against the server — lock state and transcript stamp in one GET. What
   *  makes a session someone else is running watchable here. The open /resume
   *  list refreshes on the same clock. Test seam. */
  pollMs?: number;
  /** The toolbar's task count — how often the session's container is asked
   *  what is running while this window idles. Turn ends and opening /tasks
   *  refresh it too; this clock only keeps the count honest between them
   *  (a dev server dying quietly must not read "1 task" all day). Test seam. */
  taskPollMs?: number;
  /** Settings as index.tsx read them a moment ago, used for the FIRST agent
   *  build only — that happens synchronously as the store is created. Every
   *  later read goes to the server. Not a cache: nothing reads it twice. */
  bootConfig?: Record<string, ConfigValue>;
  /** Width of the voice pane as a percent of the terminal, when `sidebar_width`
   *  is not set (tests). */
  sidebarPercent?: number;
  /** Test seam: the voice client. The real one spawns the Python sidecar. */
  makeVoice?: () => VoiceClient;
  /** Test seam: the Assistant (the brain). The real one reads the config
   *  chain and builds a live model, like makeAgent. */
  makeAssistantAgent?: typeof buildAssistantAgent;
  /** The Assistant's workspace tools for one session — the real one is
   *  phantomTools(pick:'readonly') (read ls find grep, the server's
   *  non-mutating set). Rebuilt onto whichever session is on screen. */
  newAssistantTools?: (sessionId: string) => Promise<Record<string, Tool>>;
  /** The screen mirror (screen.ts): what text is at which cells, and the
   *  selection highlight. Absent in tests — selection still tracks, copies
   *  nothing. */
  screen?: Screen;
  /** A session to seat on the first frame — the test seam's door. The real
   *  launch passes `boot` instead and the window opens EMPTY: the app must
   *  come up whatever is wrong (a dead token, an unreachable server), because
   *  the screens that fix those problems are all in here. */
  initial?: Initial;
  /** What launching wants: resume a named session, or find a workspace and
   *  start — the same flow /new and /workspace run, so a failure lands as
   *  words in the pane instead of a stack trace before the app exists. */
  boot?: { resumeId?: string };
  /** Tools are per-session, so every session that joins needs a fresh set.
   *  `plan` builds the plan-mode kit instead: the readonly preset on the
   *  mutating kits — /plan swaps between the two. */
  newTools: (sessionId: string, plan?: boolean, workspaceId?: string) => Promise<Record<string, Tool>>;
  configPath?: string;
  /** Test seam: the real one reads the config chain and builds a live model. */
  makeAgent?: typeof buildAgent;
  /** Test seam. A factory, not an instance — there is one per open session. */
  makeTranscript?: (header: TranscriptHeader) => Transcript;
  /** Test seam: replay for a session as it joins. Empty when it has no file. */
  loadHistory?: (sessionId: string) => ModelMessage[];
  /** Test seam: the stored system prompt for a session as it joins. */
  loadPrompt?: (sessionId: string) => string | undefined;
  /** Test seam: the turn runner the store drives. */
  run?: typeof runTurn;
  /** Fired whenever the live session changes — /new, /resume, /workspace and
   *  tab all switch it, so the id the caller started with is not the one you
   *  are in when you quit. */
  onSession?: (s: { id: string; branch: string; workspaceId: string }) => void;
}) {
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const screenRows = rows || 24;
  const screenCols = columns || 80;
  // One empty frame after every resize. Ink's incremental renderer (index.tsx)
  // diffs each frame against a cache of the previous one, and a resize moves
  // the alt-screen content under that cache — Ink itself clears it only when
  // the width shrinks. Collapsing the root to nothing for a frame sends Ink
  // down its full-clear path, so the next real frame is written whole and no
  // stale line survives. Children stay mounted; only the layout collapses.
  const [repaint, setRepaint] = useState(false);
  const lastSize = useRef({ cols: screenCols, rows: screenRows });
  if (lastSize.current.cols !== screenCols || lastSize.current.rows !== screenRows) {
    lastSize.current = { cols: screenCols, rows: screenRows };
    if (!repaint) setRepaint(true);   // state-during-render: re-renders before anything draws
  }
  useEffect(() => { if (repaint) setRepaint(false); }, [repaint]);
  // Settings are READ WHERE THEY ARE USED — when a sidecar spawns, when an
  // agent is built, when a screen opens. There is no resolved object held here
  // and none passed down: that is a cache, and it went stale the moment
  // anything wrote through another door (save a key on /keys and the Assistant
  // still spawned with the env it was born with).
  const settings = useMemo(() => makeSettings(api), [api]);
  const readCfg = useCallback(async (): Promise<Record<string, ConfigValue>> =>
    ({ ...await settings.read(), ...localValues(configPath) }), [settings, configPath]);
  const [cfgTick, setCfgTick] = useState(0);
  // The two values the CHROME needs every frame. Read once when they change,
  // passed down as numbers — never a settings object, so there is nothing to
  // go stale beyond these two.
  const [chrome, setChrome] = useState<{ voice: boolean; width: number }>(
    { voice: Boolean(bootConfig?.voice_enabled), width: Number(bootConfig?.sidebar_width) || sidebarPercent });
  // The Assistant's voice client, over the Python sidecar — outside React like
  // the session store; `bump` below is its re-render signal too.
  const [voice] = useState(() => makeVoice());
  const vs = voice.snapshot();
  // The voice pane, on the right. Shown when voice is on; ctrl+g overrides
  // that either way. Its share of the width is a setting (percent).
  const [sidebar, setSidebar] = useState<boolean | null>(null);
  const showSidebar = sidebar ?? chrome.voice;
  const sidePercent = chrome.width || sidebarPercent;
  const sideCols = showSidebar ? Math.max(16, Math.floor((screenCols * sidePercent) / 100)) : 0;
  const mainCols = screenCols - sideCols;
  const width = Math.max(20, mainCols - 2);
  // The block under the conversation pane (in-flight output, status, prompt,
  // toolbar) is budgeted so the pane keeps most of the screen.
  const liveRows = Math.max(3, Math.floor(screenRows / 3));
  // Rows up from the bottom of the conversation (pageUp/pageDown). 0 follows
  // the tail; anything you send snaps it back to 0.
  const [scroll, setScroll] = useState(0);
  const [scrollMax, setScrollMax] = useState(0);
  // The voice pane scrolls with the wheel over it (it has no keys).
  const [voiceScroll, setVoiceScroll] = useState(0);
  const [voiceScrollMax, setVoiceScrollMax] = useState(0);
  // THE scroll rule, for both panes and every way of asking: a positive `rows`
  // goes back in history, and the result stays between the tail and as far up
  // as the pane last said it can show. The wheel and the two keys differ only
  // in how many rows they ask for — they used to each clamp for themselves,
  // three copies of one rule that could drift apart.
  const scrollBy = useCallback((pane: 'chat' | 'voice', rows: number) => {
    const [set, max] = pane === 'chat'
      ? [setScroll, scrollMax] as const : [setVoiceScroll, voiceScrollMax] as const;
    set((s) => Math.max(0, Math.min(max, s + rows)));
  }, [scrollMax, voiceScrollMax]);
  // Where the prompt's two rules are, as screen rows, so the divider can draw
  // a junction where they meet it. Measured, not computed from the bottom:
  // the toolbar notice and the command menu move the prompt. The bottom block
  // starts at row 0 of the main column (nothing above it but the pane), so
  // its top plus the prompt's top within it is the screen row.
  const bottomRef = useRef(null);
  const { top: bottomTop, hasMeasured: bottomMeasured } = useBoxMetrics(bottomRef);
  const [promptTop, setPromptTop] = useState<number | null>(null);
  const junctions = bottomMeasured && promptTop !== null
    ? [bottomTop + promptTop, bottomTop + promptTop + 2] : [];
  // Drag-to-select: a selection lives from press to release, clamped to the
  // pane it started in; on release its text is copied. Kept in a ref — the
  // events arrive faster than a render.
  const selection = useRef<Selection | null>(null);

  // The kanban board, one store per workspace, shared by everything: the
  // /kanban view renders from it, the Assistant's `kanban` tool edits it, and
  // so does every coding session's — so a tool edit repaints an open board
  // with no extra wiring. Declared above the session store because the store's
  // initialiser needs the coding kit on the first frame.
  const boards = useRef(new Map<string, BoardStore>());
  const boardFor = useCallback((workspaceId: string): BoardStore => {
    let b = boards.current.get(workspaceId);
    if (!b) { b = new BoardStore(api, workspaceId, stream); b.follow(); boards.current.set(workspaceId, b); }
    return b;
  }, [api, stream]);
  useEffect(() => () => { for (const b of boards.current.values()) b.close(); }, []);

  // The coding agent's board handler, bound to the session's OWN workspace —
  // not the one on screen: a turn keeps running while you switch away. Same
  // ops as the Assistant's handler, minus the screen: reading a card and
  // reporting on it is the whole job.
  const codingKanbanHandler = useCallback((workspaceId: string) =>
    (args: KanbanArgs) => kanbanOps(boardFor(workspaceId), args), [boardFor]);

  // The mode handlers — a session's plan/code mode, carried by both in-window
  // agents. getMode reads the SESSIONS TABLE (GET /sessions/:id), not this
  // window's mirror: the mirror is refreshed by the watch below for the
  // session on screen only, so a session open in the background could answer
  // from a copy the looper or another window has since changed. Having read
  // the row it FOLLOWS it (applyPlanMode — the elsewhere-watch's move, a no-op
  // while they agree), so the answer and this window's kit converge instead of
  // drifting until the next poll. A turn already streaming keeps the agent it
  // started with, so a mid-turn follow lands on the NEXT turn (/model's rule).
  // enterPlan is /plan's on-switch (the row
  // PATCHed first, then this window's kit) — ONE WAY from an agent: no path
  // back to code mode exists here, only the user's /plan. Bound to a session
  // id for the coding agent; unbound = the session on screen, for the
  // Assistant. Takes the store as an argument because the seed path runs
  // inside the store's own initialiser; applyPlanRef is filled further down,
  // before any tool runs.
  const screenOps = useCallback((st: SessionStore, sessionId?: string): ScreenModeHandler => ({
    getMode: async () => {
      const e = sessionId ? st.get(sessionId) : st.active();
      if (!e) return { error: 'no session is open' };
      try {
        const r = await api('GET', `/sessions/${e.id}`) as { planMode?: boolean };
        if (typeof r?.planMode !== 'boolean') throw new Error('the row carried no plan_mode');
        await applyPlanRef.current?.(e.id, r.planMode);
        return { mode: r.planMode ? 'plan' : 'code' };
      } catch (err) {
        // The record is out of reach: answer with what this window holds and
        // SAY so — a mode the agent cannot check is worse than a noted one.
        return { mode: e.planMode ? 'plan' : 'code',
          note: `could not read the session row (${(err as Error).message}) — this is what this window holds` };
      }
    },
    enterPlan: async () => {
      const e = sessionId ? st.get(sessionId) : st.active();
      if (!e) return { ok: false, error: 'no session is open' };
      if (e.readonly) return { ok: false, error: 'a supervisor record has no modes' };
      if (e.planMode) return { ok: false, error: 'already in plan mode' };
      await api('PATCH', `/sessions/${e.id}`, { plan_mode: true });
      await applyPlanRef.current?.(e.id, true);
      return { ok: true };
    },
  }), [api]);

  // The task-count refresh, by ref: the store's onTurnEnd callback below is
  // created once, before refreshTasks can exist (it needs state declared
  // later), so it reads the CURRENT one at call time — applyPlanRef's rule.
  const refreshTasksRef = useRef<(() => Promise<void>) | null>(null);

  // One store for the window, seeded with the session it launched into. Built
  // in the initialiser so the banner is on screen for the first frame.
  const [store] = useState(() => {
    // When a turn ends, the whole local file goes to the server — SQL is the
    // record. Chained per session: two turns ending close together must land
    // in order, or a stale upload could overwrite the newer one. A failure is
    // noted ONCE per streak — the next successful sync says so too — so a
    // server that cannot store transcripts is one line, not one per turn.
    const chains = new Map<string, Promise<void>>();
    const failing = new Set<string>();
    const s: SessionStore = new SessionStore(run, (e) => {
      const prev = chains.get(e.id) ?? Promise.resolve();
      chains.set(e.id, prev.then(() => syncTranscriptUp(api, e.id, e.transcript.path)).then(
        (stamp) => { s.setStamp(e.id, stamp); if (failing.delete(e.id)) s.note(e.id, 'transcript sync recovered'); },
        (err) => {
          if (failing.has(e.id)) return;
          failing.add(e.id);
          s.note(e.id, `transcript sync failed (kept locally): ${(err as Error).message}`);
        },
      // The turn's lock is released once the record landed (or failed —
      // holding it helps nobody; the file is kept locally either way).
      ).finally(() => { void api('DELETE', `/sessions/${e.id}/lock`).catch(() => {}); }));
      // The toolbar's task count follows every turn — a turn is when tasks
      // start and stop. Best effort, like everything in this callback.
      void refreshTasksRef.current?.().catch(() => {});
    });
    // Lock per TURN: taken as a send starts, released above. Opening a
    // session never locks — reading is free for everyone. The lock response
    // carries the transcript's stamp: unchanged = memory is current, run on
    // it; moved = another machine advanced this session — pull ONCE, reseat,
    // then run. This is what makes whole-file saves safe with many writers.
    s.onTurnStart = async (id) => {
      const r = await api('POST', `/sessions/${id}/lock`, { label: hostname() }) as
        { transcript_updated_at?: string | null };
      await reseatIfMoved(api, s, id, r?.transcript_updated_at ?? null);
    };
    // This window's own turn, relayed to the server as it runs, so any
    // watcher sees it stream exactly like a turn the server runs. The lock
    // taken above is what entitles this window to publish.
    s.relay = async (id, events) => { await api('POST', `/sessions/${id}/events`, { events }); };
    // Seeding is the test seam's path: a session on the first frame. The real
    // launch starts EMPTY and the boot effect below opens the first session
    // through the same openSession every /new and /workspace uses.
    if (initial) {
      // The system prompt: the stored one on resume, a fresh stack otherwise —
      // assembled ONCE here and frozen into the transcript header, so this
      // session keeps these instructions for life (prompt-file edits reach new
      // sessions only). The current date is appended at agent build, unstored.
      const instructions = initial.instructions ?? codingInstructions(initial.skills ?? [], initial.git);
      // The file tools came in from the caller; the board tool is built here,
      // because only the window has the board.
      const tools = { ...initial.tools, ...codingKanbanTool(codingKanbanHandler(initial.workspaceId)),
        ...screenModeTools(screenOps(s, initial.sessionId)) };
      const { agent, summary } = makeAgent(tools, bootConfig ?? REMOTE_DEFAULTS, instructions,
        (t) => s.note(initial.sessionId, t));
      const transcript = makeTranscript({
        type: 'session', session_id: initial.sessionId, workspace: initial.workspaceId,
        branch: initial.branch, provider: summary.provider, model: summary.model,
        created_at: new Date().toISOString(), system_prompt: instructions,
      });
      s.add({
        id: initial.sessionId, branch: initial.branch, workspaceId: initial.workspaceId,
        tools, agent, summary, transcript, instructions,
        history: initial.resumed,
        ...(initial.readonly ? { readonly: true } : {}),
        done: [
          ...bannerParts({ workspace: initial.workspace ?? initial.workspaceId, branch: initial.branch }, summary),
          ...messagesToParts(initial.resumed),
        ],
      });
    }
    return s;
  });
  // The store is mutable and lives outside React; this is the re-render signal.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => store.subscribe(bump), [store]);
  useEffect(() => voice.subscribe(bump), [voice]);

  // The session on screen — or NONE. The window opens whatever is wrong (that
  // is the point: the screens that fix a dead token or a bad address are all
  // in here), so every consumer below tolerates the empty state and the pane
  // shows the window's own notes until the first session joins.
  const session = store.active();
  const sessionId = session?.id;
  // Notes with no session to land in — a failed boot open, a refused command.
  // Rendered where the conversation would be; superseded once a session joins.
  const [windowNotes, setWindowNotes] = useState<Part[]>([]);

  // A session someone else is RUNNING — the lock is per turn, so locked =
  // a turn is live there (a looper round, another window) — is read-only
  // here. WHO holds it comes off the feed (`session.held`, the feed's `lock`
  // records: first thing on connect, then every change) and lapses on this
  // window's clock at the hold's expiry, so a holder that died without
  // releasing does not spin here for ever. The watch below is the backstop
  // for the record and plan mode: every pollMs one GET carries the transcript
  // stamp; a moved stamp pulls and reseats. The send-time lock refusal in the
  // store is the backstop for everything.
  const heldNow = session?.held && session.held.expiresAt > Date.now() ? session.held : null;
  const heldRef = useRef(heldNow);
  heldRef.current = heldNow;
  // The watch's door to applyPlanMode, which is defined further down (it needs
  // the tool factories) — the openSessionRef pattern.
  const applyPlanRef = useRef<((id: string, on: boolean) => Promise<void>) | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    let gone = false;
    const look = async () => {
      const cur = store.get(sessionId);
      if (!cur || cur.busy || cur.readonly) return;
      try {
        const r = await api('GET', `/sessions/${sessionId}`) as {
          planMode?: boolean; transcript_updated_at?: string | null };
        if (gone) return;
        // Plan mode flipped somewhere else (another window's /plan): the row
        // is the record, so this window follows it — a no-op while they agree.
        if (typeof r.planMode === 'boolean') await applyPlanRef.current?.(sessionId, r.planMode);
        await reseatIfMoved(api, store, sessionId, r.transcript_updated_at ?? null);
      } catch { /* an unreachable server must not brick the prompt */ }
    };
    void look();
    const t = setInterval(() => { void look(); }, pollMs);
    t.unref?.();
    return () => { gone = true; clearInterval(t); };
  }, [api, store, sessionId, pollMs]);
  // The session on screen, streamed live. The watch above says WHO is working
  // and pulls the record; this shows the work itself — every part of a turn
  // the server runs (a looper round, the turn route), folded through the same
  // reducer a local turn uses. Only the session on screen is followed: nobody
  // is looking at the others. No stream wired (tests) = the poll alone, as
  // before.
  useEffect(() => {
    if (!stream || !sessionId) return;
    const feed = new SessionFeed(stream, sessionId, store, {
      onRecordLanded: (updatedAt, keepScreen) => {
        void reseatIfMoved(api, store, sessionId, updatedAt || null, keepScreen)
          .catch(() => { /* the watch poll is the backstop */ });
      },
    });
    feed.start();
    return () => feed.stop();
  }, [stream, api, store, sessionId]);

  // The countdown repaints once a second, only while someone else holds it
  // — and it is what notices the hold lapsing on this window's clock.
  useEffect(() => {
    if (!heldNow) return;
    const t = setInterval(bump, 1000);
    t.unref?.();
    return () => clearInterval(t);
  }, [heldNow !== null]);

  // Window facts the session handler reads at CALL time, never at build time.
  // The Assistant's agent is built once (voice start / model change), so a
  // handler that closed over today's values would answer with them forever —
  // the same ref rule workspaceRef and viewRef follow further down.
  // openSession itself is defined below (it needs the pickers' plumbing).
  const openSessionRef = useRef<((t: OpenTarget) => Promise<boolean>) | null>(null);
  // Same rule for closing: the Assistant's handler is built before closeSession
  // exists, so it reads the current one at call time.
  const closeSessionRef = useRef<((id?: string) => Promise<unknown>) | null>(null);
  const [wsDirectory] = useState(() => new WorkspaceDirectory(api));

  // What the Assistant may do to the TUI: the `session_*` family, one handler.
  //
  // LIST is the SERVER's answer, not this window's. The store only holds the
  // sessions you opened here — listing from it made the Assistant say "just
  // one" while the workspace held fifty, and made "which are running" mean
  // "which are running in front of me". The window still supplies the two
  // facts the server cannot know: which session is on screen, and which is
  // mid-turn locally.
  //
  // Paging is offset/limit, matching session_read and kanban_card_history
  // rather than the cursor /resume uses: the caller is a model, and an offset
  // is something it can reason about, while a two-field cursor is something it
  // must copy back perfectly. The page is ONE request — ask for the rows up to
  // the end of the window (plus the lookahead), drop the first offset, and
  // never re-sort: the ordering has exactly one home, on the server.
  const assistantTool = useCallback(async (args: SessionsArgs) => {
    if (args.action === 'list') {
      const limit = Math.min(Math.max(1, Math.trunc(args.limit ?? SESSION_PAGE)), SESSION_MAX);
      const offset = Math.max(0, Math.trunc(args.offset ?? 0));
      // One row past the window is the LOOKAHEAD: it is the difference
      // between "the page came back full" (which cannot tell a full list from
      // one with more behind it) and knowing. It is fetched, never shown.
      const want = offset + limit + 1;
      if (want > SESSION_REACH) {
        return { error: `the list reaches ${SESSION_REACH} sessions back; offset + limit must stay inside that`,
          on_screen: store.activeId };
      }
      let rows: SessionInfo[];
      try {
        // The workspace names ride along on the first list, in parallel, and
        // stay in the cache after that (WorkspaceDirectory).
        const [got] = await Promise.all([
          api('GET', `/sessions?limit=${want}`),
          wsDirectory.ensure(),
        ]);
        // A server that answers something other than a list is a broken
        // server, not a crashed tool: say so and keep the window usable.
        const list = (got as { sessions?: unknown })?.sessions;
        rows = Array.isArray(list) ? list as SessionInfo[] : [];
      } catch (e) {
        return { error: `could not reach the server: ${(e as Error).message}`, on_screen: store.activeId };
      }
      const page = rows.slice(offset, offset + limit);
      const busy = (id: string) => store.get(id)?.busy ?? false;
      const wsName = (id: string) => wsDirectory.name(id);
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
          workspace: wsName(s.workspaceId),
          card: s.card ?? null,
          // Who drives it — the launcher's own three-way. Supervisor rows are
          // MARKED, not hidden: the looper mints one per card, and a list that
          // silently drops half of itself is a list that lies.
          kind: s.agent === 'supervisor' ? 'supervisor' : s.card != null ? 'looper' : 'manual',
          status: s.status === 'active' ? 'active' : 'ended',
          running: isRunning(s, { busy, clientId }),
          on_screen: s.id === store.activeId,
          last_message: oneLine(s.lastUserMessage),
          when: ago(s.lastUsedAt),
          // No branch: it is the session id wearing a prefix and says nothing
          // to a person (the same reason /resume's table leaves it out).
        })),
      };
    }
    if (args.action === 'get_active') {
      // The window knows WHICH session is on screen — nothing else can. What
      // identifies it to a person (title, card) lives on the row, so this is
      // one GET for that session alone, where the same answer used to cost a
      // whole session_list page. Mode is deliberately absent: session_get_mode
      // answers that, and one field with two homes is a field that drifts.
      const id = store.activeId;
      const e = id ? store.get(id) : undefined;
      if (!e) return { error: 'no session is on screen' };
      try {
        const [row] = await Promise.all([
          api('GET', `/sessions/${id}`) as Promise<{ name?: string | null; card?: number | null; status?: string }>,
          wsDirectory.ensure(),
        ]);
        return { id, title: row?.name ?? null, workspace: wsDirectory.name(e.workspaceId),
          card: row?.card ?? null, status: row?.status === 'active' ? 'active' : 'ended',
          running: e.busy };
      } catch (err) {
        // The server is out of reach; which session is on screen is still this
        // window's own fact, so answer it and say what is missing.
        return { id, workspace: wsDirectory.name(e.workspaceId), running: e.busy,
          note: `could not read the session row (${(err as Error).message}) — title and card unavailable` };
      }
    }
    if (args.action === 'switch') {
      // ONE open path, always — openSession decides whether the session is
      // already here, needs attaching, or (having been swept) needs
      // restarting. No local-vs-remote branch, and no partial-id matching:
      // that took the FIRST session whose id started with the argument, so an
      // ambiguous prefix silently landed on the wrong conversation. Ids come
      // from session_list in the same breath; exact is the whole story.
      const id = String(args.id ?? '').trim();
      if (!id) return { error: 'session_switch needs an id — session_list has them' };
      const ok = await openSessionRef.current?.({ kind: 'open', id });
      if (!ok) {
        return { error: `could not open session ${id} — check the id against session_list; ` +
          'the conversation pane says what went wrong' };
      }
      return { ok: true, on_screen: store.activeId };
    }
    if (args.action === 'close') {
      // The app's one close path; its result is already the answer — what
      // closed, what is on screen now, whether a fresh session had to open.
      const id = args.id ? String(args.id).trim() : undefined;
      return closeSessionRef.current?.(id) ?? { error: 'the window is not ready to close a session yet' };
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
  }, [store, api, clientId, wsDirectory]);

  // What the LEFT PANE is showing — one state, one answer: the chat, the
  // kanban board (/kanban or the Assistant), or ONE card alone (asked for
  // from chat: no board first, and closing it goes back to chat). A card
  // opened from the BOARD is the Board's own edit sub-state, not a view.
  // One variable means the impossible states (board AND solo card) cannot
  // exist, and every "is the pane mine?" check asks the same question.
  const [view, setView] = useState<'chat' | 'board' | { card: number }>('chat');

  // ── the approval gate ──────────────────────────────────────────────────────
  // The Assistant's gated tool (workspace_create_repo) waits here until the
  // user answers. It is the ASSISTANT asking, so the ask lives in ITS pane —
  // three condensed rows under the header: what kind, the subject (the exact
  // name about to exist), `accept · decline`. Answered by clicking either
  // word or by SAYING it: voice.intercept claims everything that reaches
  // turn() while one stands — the exact word "accept" or "decline" acts,
  // anything else is swallowed (exact match like the wake word, never
  // interpretation). No keyboard chord: the chat prompt stays live, and a
  // letter key would collide with typing. ONE approval at a time; the tool
  // call's abort — the user cut the Assistant off — declines, so a dead turn
  // cannot leave the ask up waiting for an answer nothing would receive.
  type Approval = { label: string; subject: string; resolve: (ok: boolean) => void };
  const [approval, setApproval] = useState<Approval | null>(null);
  // The live answer to "is one pending?" — updated synchronously, because the
  // next tool call can arrive before React re-renders the state above (a
  // render-synced ref briefly said an already-answered approval still stood).
  const approvalRef = useRef<Approval | null>(null);
  const requestApproval = useCallback((ask: { label: string; subject: string }, signal?: AbortSignal): Promise<boolean> => {
    return new Promise<boolean>((resolve) => {
      if (signal?.aborted) { resolve(false); return; }
      const done = (ok: boolean) => {
        signal?.removeEventListener('abort', onAbort);
        approvalRef.current = null;
        setApproval(null);
        resolve(ok);
      };
      const onAbort = () => done(false);
      signal?.addEventListener('abort', onAbort);
      const entry = { ...ask, resolve: done };
      approvalRef.current = entry;
      setApproval(entry);
      // The ask is in the voice pane — make sure the pane is on screen (the
      // same nudge /assistant gives; an explicit ctrl+g hide is respected no more).
      setSidebar((s) => (s === false ? null : s));
    });
  }, []);
  useEffect(() => {
    voice.intercept = (text: string) => {
      const a = approvalRef.current;
      if (!a) return false;
      const word = text.toLowerCase().replace(/[^a-z]/g, '');
      if (word === 'accept') a.resolve(true);
      else if (word === 'decline') a.resolve(false);
      return true;
    };
    return () => { voice.intercept = null; };
  }, [voice]);

  // `workspace_create_repo`: kebab the name, get the user's accept (the
  // prompt shows the FINAL name — the point of the gate), then the backend
  // does the whole flow (POST /workspaces create=true: repo, seed, register;
  // always private — not the model's call) and the new workspace opens as a
  // session on screen, the same join+switch every open uses.
  const workspaceCreateHandler = useCallback(async (args: WorkspaceCreateArgs, opts: { abortSignal?: AbortSignal }) => {
    const name = kebabName(args.name ?? '');
    if (!name) return { error: 'no usable name — ask for the project name again' };
    if (approvalRef.current) return { error: 'another approval is already waiting on screen' };
    const ok = await requestApproval({ label: 'new private repo', subject: name }, opts.abortSignal);
    if (!ok) {
      return { declined: true, note: 'nothing was created — the user declined (or the turn was cut off). ' +
        'Often the name was misheard: ask what to change before calling again.' };
    }
    try {
      const w = await api('POST', '/workspaces', {
        url: name, create: true, private: true,
        ...(args.description ? { description: args.description } : {}),
      }) as { id: string; owner: string; name: string };
      const opened = await (openSessionRef.current?.({ kind: 'new', workspaceId: w.id }) ?? false);
      return { ok: true, repo: `${w.owner}/${w.name}`, private: true, workspace_id: w.id,
        on_screen: opened ? 'a new session in the new workspace'
          : 'workspace created, but the session could not be opened — the conversation pane says why' };
    } catch (e) { return { error: (e as Error).message }; }
  }, [api, requestApproval]);

  // The Assistant's agent is built ONCE (voice start / model change), so the
  // handler must not close over the workspace of that moment: it reads the
  // CURRENT one through a ref, and stays a stable function. Empty while no
  // session is on screen — there is no workspace to point a board at yet.
  const workspaceRef = useRef(session?.workspaceId ?? '');
  workspaceRef.current = session?.workspaceId ?? '';
  // Same ref rule as the workspace: the handler is built once, the view moves.
  const viewRef = useRef(view);
  viewRef.current = view;
  const assistantKanbanHandler = useCallback(async (args: KanbanArgs) => {
    if (!workspaceRef.current) return { error: 'no session is on screen yet, so there is no workspace or board' };
    // kanban_screen moves between chat → board → column / card, and the
    // result names the level now on screen — the Assistant reports it
    // instead of guessing.
    if (args.action === 'screen') {
      if (args.show === 'off') { setView('chat'); return { ok: true, screen: 'chat' }; }
      const b = boardFor(workspaceRef.current);
      if (!b.state.loaded) await b.load();
      if (args.show === 'column') {
        // One column across the whole width — the board's [e]. Spoken names
        // are forgiven the way a move's are; the Board consumes the request
        // once it is up (from chat it comes up first).
        if (args.column === undefined) return { error: 'show column needs the column name' };
        const col = resolveColumn(b, args.column);
        if (!col) return { error: `no column "${args.column}" — the columns are: ${b.state.columns.join(', ')}` };
        setView('board');
        b.requestColumn(col);
        return { ok: true, screen: `column ${col}, expanded` };
      }
      if (args.show === 'card') {
        const up = viewRef.current === 'board';
        if (args.card === undefined) return { error: 'show card needs the card number', screen: up ? 'board' : 'chat' };
        if (!b.bySeq(args.card)) return { error: `no card ${args.card}`, screen: up ? 'board' : 'chat' };
        // Board already up → the card opens on it (esc goes back to columns).
        // From chat → the card alone; esc goes back to chat, no board first.
        if (up) { b.requestCard(args.card); return { ok: true, screen: `card ${args.card}, on the board` }; }
        setView({ card: args.card });
        return { ok: true, screen: `card ${args.card}` };
      }
      setView('board');
      b.requestBoard(); // "show the board" means every column: an open editor drops, an expanded column collapses
      return { ok: true, screen: 'board' };
    }
    return kanbanOps(boardFor(workspaceRef.current), args);
  }, [boardFor]);

  // Declared before startVoice, which notes a failed Assistant build. With no
  // session on screen the note is the WINDOW's and renders where the
  // conversation would be — a boot that failed must say so on screen.
  const note = useCallback((text: string) => {
    setSplash(false);
    if (store.active()) store.note(store.activeId, text);
    else setWindowNotes((l) => [...l, { kind: 'note', id: nextId('note'), text } as Part]);
  }, [store]);
  // The Deepgram address the engine is on is a fact about this machine's
  // network: saved with the other local facts, handed back at the next spawn
  // so a fresh engine does not start on whatever DNS says that minute.
  useEffect(() => {
    voice.onAddress = (addr: string) => {
      const err = addr ? setLocal('voice_deepgram_address', addr, configPath) : clearLocal('voice_deepgram_address', configPath);
      if (err) note(err);
    };
    return () => { voice.onAddress = null; };
  }, [voice, configPath, note]);

  /** The Assistant's whole kit: the two TUI tools plus read-only workspace
   *  tools scoped to the session ON SCREEN. Rebuilt (setAgent — history kept)
   *  when that session changes; a failed fetch just means no file tools. */
  const assistantKit = useCallback(async () => ({
    ...sessionsTool(assistantTool), ...assistantKanbanTool(assistantKanbanHandler),
    ...workspaceCreateTool(workspaceCreateHandler),
    ...screenModeTools(screenOps(store)),
    ...(sessionId ? await newAssistantTools(sessionId).catch(() => ({} as Record<string, Tool>)) : {}),
  }), [assistantTool, assistantKanbanHandler, workspaceCreateHandler, newAssistantTools, sessionId, screenOps, store]);

  // Voice follows the setting: on at launch when enabled, stopped with the
  // window. Restarted by onConfigChange when a boot-time setting moves.
  const startVoice = useCallback(() => {
    void (async () => {
      // READ AT SPAWN. The sidecar takes its Deepgram key from the environment
      // it is started with, so reading it here — not at app boot — is what lets
      // you save the key and turn the Assistant on and have it work the first
      // time, instead of switching it off and on to get a second attempt.
      const cfg = await readCfg().catch(() => null);
      if (!cfg) return;   // index.tsx refuses to start without the server
      // A bad agent trio (assistant_provider overridden, no model) throws at
      // build — say so instead of dying in a floating promise.
      let built;
      try { built = makeAssistantAgent(await assistantKit(), cfg); }
      catch (e) { note(`assistant not started: ${(e as Error).message}`); return; }
      voice.setAgent(built.agent, built.summary);
      void voice.start(sidecarEnv(cfg));
    })();
  }, [voice, readCfg, assistantKit, makeAssistantAgent, note]);
  // The read tools follow the session on screen: switching sessions rebuilds
  // the Assistant's kit in place (same conversation, new session's files).
  useEffect(() => {
    if (!voice.running) return;
    let stale = false;
    void (async () => {
      const cfg = await readCfg().catch(() => null);
      const kit = await assistantKit();
      if (stale || !cfg) return;
      try { voice.setAgent(makeAssistantAgent(kit, cfg).agent); }
      catch { /* a bad trio was already reported where it was written */ }
    })();
    return () => { stale = true; };
  }, [sessionId]);  // eslint-disable-line react-hooks/exhaustive-deps -- only the session switch triggers it

  useEffect(() => {
    // The chrome's two values, and the launch decision, from one read.
    void readCfg().then((c) => {
      setChrome({ voice: Boolean(c.voice_enabled), width: Number(c.sidebar_width) || sidebarPercent });
      if (c.voice_enabled) startVoice();
    }).catch(() => { /* index.tsx already refused to start without the server */ });
    return () => voice.stop();
    // Launch only: later changes go through onConfigChange.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [expanded, setExpanded] = useState(false);   // ctrl+o toggles it
  const [input, setInput] = useState('');
  const [ctrlC, setCtrlC] = useState(false);
  const [menu, setMenu] = useState<Menu>(null);
  // The launch splash: the big PHANTOM LOOPER where the conversation will be.
  // Sessions with nothing said yet — boot's first, every /new — a resume has
  // history to show. Cleared by the first interaction that wants the screen
  // back: a submitted line (message or command — /help's answer lands in the
  // pane the splash covers), a session switch, a note, a menu or the board
  // opening. Set back only where openSession seats an empty session.
  const [splash, setSplash] = useState(initial ? initial.resumed.length === 0 : true);
  useEffect(() => { if (menu !== null || view !== 'chat') setSplash(false); }, [menu, view]);
  const [picker, setPicker] = useState<{ workspaces: WorkspaceInfo[]; sessions: SessionInfo[]; total: number; end: boolean } | null>(null);
  // [s] on /resume: the looper's supervisor seats in the list or not. Held
  // here, not in the screen, because it is a fetch parameter — the server
  // decides what the list is.
  const [showSupervised, setShowSupervised] = useState(false);
  const showSupervisedRef = useRef(showSupervised);
  showSupervisedRef.current = showSupervised;
  // Trash refusals speak on the picker itself (Screen's notice line) — a
  // note() would land in the conversation the menu is covering, unread.
  const [pickerNotice, setPickerNotice] = useState<string | undefined>();
  // [t] on a session with unpushed work refuses once and arms; the same [t]
  // again discards. Armed per session id, dropped when the picker reopens.
  const trashArmed = useRef<string | null>(null);
  const [suggestAt, setSuggestAt] = useState(0);
  const [addError, setAddError] = useState<string | undefined>();
  // Which workspace the settings screen is showing. Held apart from `menu` so
  // closing that screen can land back on the list it was opened from.
  const [editing, setEditing] = useState<WorkspaceInfo | null>(null);
  // Names for the switcher's rows, fetched the first time that screen is
  // opened and never at launch: a request for a screen you may never look at
  // is a request too many, and the row reads fine as a workspace id until it
  // lands. Nothing here waits on it — ctrl+n opens on the keystroke.
  const [names, setNames] = useState<WorkspaceInfo[]>([]);
  // The session handler reads these at call time: a list this screen fetched
  // saves the handler its own request (it fetches for itself when it needs
  // names before any screen has).
  wsDirectory.offer(names);
  // ↑/↓ through what you said before. 0 is "not browsing" — and browsing only
  // ever starts from an empty line, so there is no half-typed line to save and
  // hand back: ↓ off the end of the list lands on the empty line it started on.
  const [histAt, setHistAt] = useState(0);

  // A note lands in the pane, so it also retires the splash — a message the
  // banner covers is a message lost ("tab: this is the only session open").

  // Quitting stops every session, not just the one on screen: a turn still
  // streaming somewhere else holds an open request, and node waits for it.
  const quit = useCallback(() => { store.abortAll(); voice.stop(); exit(); }, [store, voice, exit]);

  // Switching shows that session's conversation in the pane, tail first.
  const switchTo = useCallback((id: string) => {
    if (!store.activate(id)) return;
    setSplash(false);
    setScroll(0);
    setHistAt(0);
    const e = store.get(id);
    if (e) onSession?.({ id: e.id, branch: e.branch, workspaceId: e.workspaceId });
    // Cheap staleness check in the background: compare the server's transcript
    // stamp with what memory matches; pull only when it actually moved.
    if (e && !e.busy) {
      void (async () => {
        try {
          const row = await api('GET', `/sessions/${id}`) as { transcript_updated_at?: string | null };
          await reseatIfMoved(api, store, id, row?.transcript_updated_at ?? null);
        } catch { /* stale view is not worth an error line */ }
      })();
    }
  }, [store, onSession, api]);

  const openSwitcher = useCallback(() => {
    setMenu('sessions');
    if (names.length) return;
    void (async () => {
      try { setNames(await api('GET', '/workspaces') as unknown as WorkspaceInfo[]); }
      catch { /* rows keep the workspace id, which still identifies the row */ }
    })();
  }, [api, names.length]);

  const cycle = useCallback((dir: 1 | -1) => {
    const target = store.next(dir);
    if (!target) { note('this is the only session open — /new or /resume opens another'); return; }
    switchTo(target.id);
  }, [store, switchTo, note]);

  // A setting changed. Everything that consumes one READS IT AGAIN here —
  // rebuilding an agent, restarting the sidecar, pushing a live switch. Nothing
  // is recomputed from a copy taken earlier, which is what used to leave the
  // Assistant running on the settings it was born with.
  const onConfigChange = useCallback((key?: ConfigKey) => {
    setCfgTick((t) => t + 1);
    void (async () => {
      const cfg = await readCfg().catch(() => null);
      if (!cfg) { note('could not read settings from the server'); return; }
      setChrome({ voice: Boolean(cfg.voice_enabled), width: Number(cfg.sidebar_width) || sidebarPercent });

      if (session) {
        const before = session.summary;
        const next = makeAgent(session.tools, cfg, session.instructions).summary;
        if (next.provider !== before.provider || next.model !== before.model) {
          session.transcript.appendEvent({ type: 'model', provider: next.provider, model: next.model, at: new Date().toISOString() });
          note(`model → ${next.provider}/${next.model}`);
        }
      }
      store.rebuildAgents((tools, instructions, id) => makeAgent(tools, cfg, instructions,
        (t) => { if (id) store.note(id, t); }));

      // The Assistant follows its settings: on/off starts and stops it; an
      // audio value (the Deepgram key, the devices) restarts the sidecar, which
      // reads them again as it spawns; a model value rebuilds the brain in
      // place — the history stays, the next turn uses the new model; the spoken
      // voice, the mutes, headphones and the wake word are pushed live.
      if (key === 'voice_enabled') {
        if (cfg.voice_enabled) startVoice(); else voice.stop();
        setSidebar(null);
      } else if (voice.running && key && VOICE_BOOT_KEYS.includes(key)) {
        startVoice();
      } else if (voice.running && key && ASSISTANT_MODEL_KEYS.includes(key)) {
        try { voice.setAgent(makeAssistantAgent(await assistantKit(), cfg).agent); }
        catch (e) { note((e as Error).message); }
      } else if (voice.running && key === 'voice_spoken_voice') {
        voice.update({ voice: String(cfg.voice_spoken_voice) });
      } else if (voice.running && key === 'voice_mic_muted') {
        voice.setMic(Boolean(cfg.voice_mic_muted));
      } else if (voice.running && key === 'voice_speaker_muted') {
        voice.setSpeaker(Boolean(cfg.voice_speaker_muted));
      } else if (voice.running && key === 'voice_headphones') {
        voice.setHeadphones(Boolean(cfg.voice_headphones));
      } else if (voice.running && (key === 'voice_wake_word' || key === 'voice_wake_words' || key === 'voice_wake_timeout')) {
        voice.setWake(Boolean(cfg.voice_wake_word), String(cfg.voice_wake_words ?? ''), Number(cfg.voice_wake_timeout) || undefined);
      }
    })();
  }, [store, session, readCfg, makeAgent, note, voice, startVoice, makeAssistantAgent, assistantKit, sidebarPercent]);

  // The banner names the workspace, so opening a session needs its display
  // name — one lookup per workspace, ever, cached for the window's life
  // (names are stable enough; a rename shows up next launch). The launch
  // session's name arrived in `initial`; a failed lookup falls back to the
  // id, which still identifies the workspace.
  // One lookup carries BOTH facts the window needs about a workspace — the
  // display name for the banner and the card prefix (`PHA`: how this
  // workspace names its cards) for the toolbar's card mark — so the mark
  // costs no request of its own.
  const wsNames = useRef(new Map<string, WsFacts>(
    initial?.workspace ? [[initial.workspaceId, { label: initial.workspace }]] : []));
  const wsFacts = useCallback(async (id: string): Promise<WsFacts> => {
    const hit = wsNames.current.get(id);
    if (hit) return hit;
    try {
      const w = await api('GET', `/workspaces/${id}`) as
        { name?: string; displayName?: string | null; cardPrefix?: string };
      const found = w.displayName || w.name;
      if (found) {
        const facts: WsFacts = { label: found, ...(w.cardPrefix ? { cardPrefix: w.cardPrefix } : {}) };
        wsNames.current.set(id, facts);
        return facts;
      }
    } catch { /* the id below still identifies it */ }
    return { label: id };
  }, [api]);

  // Opening a session: it JOINS the window rather than replacing what is here.
  // One that is already loaded is switched to, never opened twice. The target
  // says what to open; core's openSession is the ONE path that resolves it
  // (create / restart / attach), holds the lock, pulls the server transcript
  // (the record) and the frozen prompt.
  type OpenTarget = { kind: 'new'; workspaceId: string } | { kind: 'open'; id: string }
    | { kind: 'duplicate'; id: string };
  const openSession = useCallback(async (target: OpenTarget): Promise<boolean> => {
    try {
      // Already open: switch to it. Already open AND on screen: say so —
      // re-adding it would reprint the same conversation for no reason.
      if (target.kind === 'open') {
        if (target.id === store.activeId) { note('already here'); return true; }
        if (store.has(target.id)) { switchTo(target.id); return true; }
      }
      const sessionId = target.kind === 'duplicate'
        ? ((await api('POST', `/sessions/${target.id}/duplicate`, {}) as { id: string }).id)
        : target.kind === 'open' ? target.id : undefined;
      // Opening READS — it can no longer be refused by a lock; any error here
      // is a real error and lands in the outer catch's note.
      const opened = await coreOpenSession({ call: api, label: hostname(),
        ...(sessionId ? { sessionId } : { workspaceId: (target as { workspaceId: string }).workspaceId }) });
      const row = opened.session as { id: string; branch: string; workspaceId: string;
        agent?: string | null; card?: number | null; planMode?: boolean;
        skills?: SkillMeta[]; secrets?: SecretIndexEntry[]; agent_git_credentials?: boolean };
      // The server record IS the conversation — unless this machine holds
      // unsaved steps on top of it (a window that died mid-turn); then the
      // local file is the fuller copy, opens here, and goes up now so the
      // record catches up. The upload can fail (another client holding the
      // session, a server that cannot store); the file is kept either way and
      // the next turn end ships it.
      const seated = adoptServerCopy(row.id, opened.raw);
      let resumed = opened.messages;
      let header = opened.header;
      let syncStamp = opened.updatedAt;
      let seatNote: string | null = null; // under the banner: what happened to the file
      if (seated.localKept) {
        const parsed = parseTranscript(seated.text);
        resumed = parsed.messages;
        header = parsed.header as TranscriptHeader | undefined;
        try {
          syncStamp = await syncTranscriptUp(api, row.id);
          seatNote = 'unsaved steps found on this machine — uploaded';
        } catch (e) {
          seatNote = `unsaved steps found on this machine — kept locally, upload failed: ${(e as Error).message}`;
        }
      }
      // The row's plan_mode seeds the mode AND picks the kit — the two must
      // never disagree, so they read the same fact.
      const planMode = row.planMode === true;
      const tools = { ...await newTools(row.id, planMode, row.workspaceId), ...codingKanbanTool(codingKanbanHandler(row.workspaceId)),
        ...screenModeTools(screenOps(store, row.id)) };
      // Same freeze rule as launch: the transcript's stored prompt wins; a
      // session without one gets a fresh stack — with the skill index the
      // create response carried (repo scanned after checkout, merged with the
      // image's system tier server-side) and the secrets index (names +
      // descriptions, never values) the same response froze.
      const instructions = header?.system_prompt
        ?? codingInstructions(row.skills ?? [],
          row.agent_git_credentials === undefined ? undefined
            : { credentials: row.agent_git_credentials },
          row.secrets ?? []);
      // Opening a session builds an agent, so it reads its model, provider and
      // key here — not from anything the window has been carrying.
      const { agent, summary } = makeAgent(tools, await readCfg(), instructions,
        (t) => store.note(row.id, t));
      // The file adoptServerCopy seated is the working copy appends extend.
      const transcript = makeTranscript({
        type: 'session', session_id: row.id, workspace: row.workspaceId, branch: row.branch,
        provider: summary.provider, model: summary.model, created_at: new Date().toISOString(),
        system_prompt: instructions,
      });
      // The card this session builds, named the way the board names it
      // (`PHA-7`) — resolved ONCE here, where both facts are in hand, so the
      // toolbar has one string to draw and no lookup of its own. A server
      // that did not send a prefix reads `card 7`, which still points at it.
      const ws = await wsFacts(row.workspaceId);
      const card = row.card != null
        ? `${ws.cardPrefix ? `${ws.cardPrefix}-` : 'card '}${row.card}` : undefined;
      store.add({
        id: row.id, branch: row.branch, workspaceId: row.workspaceId,
        tools, agent, summary, transcript, instructions,
        history: resumed,
        syncStamp,
        planMode,
        ...(card ? { card } : {}),
        ...(row.agent === 'supervisor' ? { readonly: true } : {}),
        done: [
          ...bannerParts({ workspace: ws.label, branch: row.branch }, summary),
          ...(row.agent === 'supervisor'
            ? [{ kind: 'note', id: nextId('note'),
                text: `the supervisor's record${row.card != null ? ` · card ${row.card}` : ''} — read-only` } as Part]
            : []),
          ...(seatNote ? [{ kind: 'note', id: nextId('note'), text: seatNote } as Part] : []),
          ...messagesToParts(resumed),
        ],
      });
      setScroll(0);
      setHistAt(0);
      // An empty conversation opens on the splash, exactly as boot's does —
      // /new's first frame is the wordmark, gone on the first message.
      setSplash(resumed.length === 0);
      onSession?.({ id: row.id, branch: row.branch, workspaceId: row.workspaceId });
      return true;
    } catch (e) { note(`could not open: ${(e as Error).message}`); return false; }
  }, [store, newTools, codingKanbanHandler, makeAgent, makeTranscript, loadHistory, loadPrompt, configPath, switchTo, onSession, note, wsFacts]);
  openSessionRef.current = openSession;

  // Flip a loaded session's plan mode: rebuild the kit (readonly preset on,
  // full set off) and the agent over it, then move mode and tools together
  // (store.setPlanMode). /plan calls this after its PATCH lands; the
  // elsewhere-watch calls it when the row says another window flipped it. A
  // turn already streaming keeps the agent it started with — the switch lands
  // on the next turn, /model's rule. No-op while nothing changed, and a
  // supervisor record (read-only, no chatting) never flips.
  const applyPlanMode = useCallback(async (id: string, on: boolean): Promise<void> => {
    const e = store.get(id);
    if (!e || e.readonly || e.planMode === on) return;
    const tools = { ...await newTools(id, on, e.workspaceId), ...codingKanbanTool(codingKanbanHandler(e.workspaceId)),
      ...screenModeTools(screenOps(store, id)) };
    const { agent, summary } = makeAgent(tools, await readCfg(), e.instructions,
      (t) => store.note(id, t));
    store.setPlanMode(id, on, tools, agent, summary);
  }, [store, newTools, codingKanbanHandler, makeAgent, readCfg]);
  applyPlanRef.current = applyPlanMode;

  // THE picker fetch — the only place the two lists are read. Throws on
  // failure so each caller decides what that means: opening says so and stays
  // put; a background refresh keeps quiet and keeps the list it has.
  // Sessions come in PAGES (PICKER_PAGE): opening fetches one, scrolling near
  // the bottom appends the next (morePicker), and every session ever made
  // stays reachable — the server list only grows (the looper mints two rows
  // per card). A refresh re-reads however many rows are loaded, so what is on
  // screen stays live however deep you have scrolled. A short page = the end.
  const pickerRef = useRef(picker);
  pickerRef.current = picker;
  const moreInFlight = useRef(false);
  // `git` asks the server for each row's work state (read from its checkout
  // — real time per row), so the OPENING fetch never carries it: the list
  // paints instantly with the work column blank, and the git-inclusive
  // refresh right behind it fills the words in place (fixed widths, no
  // jitter). The 10s poll keeps carrying it.
  // The list's FILTERS are the server's (`typed`, `supervisor`): a page is a
  // page on screen, and `total` is the count for exactly these filters. The
  // one addition only this window can make: sessions open HERE that the
  // server would leave out (nothing typed yet) — merged in, counted in.
  const listQuery = () => `typed=true${showSupervisedRef.current ? '' : '&supervisor=false'}`;
  const withOpenHere = (rows: SessionInfo[], total: number) => {
    const seen = new Set(rows.map((s) => s.id));
    const extras: SessionInfo[] = store.list().filter((e) => !seen.has(e.id) && !e.readonly).map((e) => ({
      id: e.id, workspaceId: e.workspaceId, branch: e.branch, status: 'active', agent: null,
      // Nothing typed = no activity: it sorts LAST, never ahead of real work.
      lastUsedAt: new Date(e.lastMessageAt || 0).toISOString(), locked: false, lastUserMessage: null,
    }));
    return { sessions: [...rows, ...extras], total: total + extras.length };
  };
  const refreshPicker = useCallback(async (git = false) => {
    const want = Math.max(pickerRef.current?.sessions.length ?? 0, PICKER_PAGE);
    const [ws, got] = await Promise.all([api('GET', '/workspaces'),
      api('GET', `/sessions?${listQuery()}&limit=${want}${git ? '&git=true' : ''}`)]);
    const { sessions: ss, total } = got as { sessions: SessionInfo[]; total: number };
    setPicker({ workspaces: ws as WorkspaceInfo[], ...withOpenHere(ss, total), end: ss.length < want });
    setNames(ws as WorkspaceInfo[]);
  }, [api, store]);
  // The next page, appended in place. The cursor is the last loaded row as
  // the client saw it; a session's last_used_at only ever grows, so a row can
  // move UP past the cursor (the refresh catches it at the top) but pages
  // going down never repeat one — the id filter is insurance for the 10s
  // refresh racing an append. Failure keeps the loaded rows; scrolling again
  // retries.
  const morePicker = useCallback(async () => {
    const p = pickerRef.current;
    // The cursor is the last SERVER row — the open-here extras are appended
    // after the pages and carry no server position.
    const tail = [...(p?.sessions ?? [])].reverse().find((r) => r.lastUserMessage !== null);
    if (!p || p.end || !tail || moreInFlight.current) return;
    moreInFlight.current = true;
    try {
      const got = await api('GET', `/sessions?${listQuery()}&limit=${PICKER_PAGE}` +
        `&before=${encodeURIComponent(tail.lastUsedAt)}&before_id=${tail.id}`) as
        unknown as { sessions: SessionInfo[]; total: number };
      setPicker((prev) => {
        if (!prev) return prev;
        const seen = new Set(prev.sessions.map((s) => s.id));
        const rows = [...prev.sessions, ...got.sessions.filter((s) => !seen.has(s.id))];
        // Server rows only, then the open-here extras go back on the end.
        return { ...prev, ...withOpenHere(rows.filter((r) => r.lastUserMessage !== null), got.total),
          end: got.sessions.length < PICKER_PAGE };
      });
    } catch { /* keep what is loaded */ }
    finally { moreInFlight.current = false; }
  }, [api]);

  // /resume is a status list — rows spin, locks appear and lapse, turns end on
  // other machines — so while it is open it re-reads the server on the same
  // clock as the elsewhere-watch (pollMs, 10s). The refresh swaps the rows in
  // place: the cursor, the notice line and an armed trash all stay put
  // (refreshPicker touches none of them). A failed tick is silent — an
  // unreachable server must not nag every 10s while old rows still serve.
  useEffect(() => {
    if (menu !== 'resume') return;
    const t = setInterval(() => { void refreshPicker(true).catch(() => {}); }, pollMs);
    t.unref?.();
    return () => clearInterval(t);
  }, [menu, refreshPicker, pollMs]);

  const openPicker = useCallback(async (which: 'workspace' | 'resume') => {
    try {
      await refreshPicker();
      setPickerNotice(undefined);
      trashArmed.current = null;
      setMenu(which);
      // The work column, a beat behind the instant open (see refreshPicker).
      if (which === 'resume') void refreshPicker(true).catch(() => {});
    } catch (e) { note(`could not list: ${(e as Error).message}`); }
  }, [refreshPicker, note]);

  // What is running in the session's container — the /tasks screen's rows and
  // the toolbar's count. The server reads the container fresh on every ask
  // (ps inside it), so this is never a stored guess going stale.
  const [tasksView, setTasksView] = useState<TasksView | null>(null);
  const [tasksNotice, setTasksNotice] = useState<string | undefined>();
  const [taskCount, setTaskCount] = useState<number | null>(null);
  const killArmed = useRef<string | null>(null);
  const refreshTasks = useCallback(async () => {
    if (!sessionId) return;
    const r = await api('GET', `/sessions/${sessionId}/tasks`) as unknown as TasksView;
    setTasksView(r);
    setTaskCount(r.tasks.length);
  }, [api, sessionId]);
  refreshTasksRef.current = refreshTasks;

  // The count's own clock: seed it when a session lands on screen, then once
  // a minute while the window idles — turn ends (the store callback) and the
  // open /tasks screen refresh it more often. A failed tick keeps the last
  // count; an unreachable server must not blank the toolbar.
  useEffect(() => {
    if (!sessionId) { setTaskCount(null); setTasksView(null); return; }
    void refreshTasks().catch(() => {});
    const t = setInterval(() => { void refreshTasks().catch(() => {}); }, taskPollMs);
    t.unref?.();
    return () => clearInterval(t);
  }, [sessionId, refreshTasks, taskPollMs]);

  // /tasks is a status list like /resume: while it is open it re-reads on the
  // picker clock (pollMs). The refresh swaps rows in place — the cursor, the
  // notice and an armed kill stay put; a failed tick is silent.
  useEffect(() => {
    if (menu !== 'tasks') return;
    const t = setInterval(() => { void refreshTasks().catch(() => {}); }, pollMs);
    t.unref?.();
    return () => clearInterval(t);
  }, [menu, refreshTasks, pollMs]);

  // /archived — the workspace's archived cards, fetched for the screen alone
  // (the board GET never carries the archive: the board doesn't render it,
  // and the archive grows forever while the board stays small). Pages like
  // /resume: one page at open, the next appended when the cursor nears the
  // bottom (moreArchived); a short page = the end.
  const [archivedNotice, setArchivedNotice] = useState<string | undefined>();
  const [archivedCards, setArchivedCards] = useState<Card[]>([]);
  /** The whole archive's size (the server's count) — the pages loaded are
   *  `archivedCards`; the screen counts what is below against this. */
  const [archivedTotal, setArchivedTotal] = useState<number | undefined>();
  const archivedRef = useRef(archivedCards);
  archivedRef.current = archivedCards;
  const archivedEnd = useRef(false);
  const moreArchivedInFlight = useRef(false);
  // /archived and the board's [v] share this. Fresh rows before the screen
  // (the /tasks shape: a failure says so and stays put).
  const openArchived = useCallback(async (workspaceId: string) => {
    try {
      const d = await api('GET', `/workspaces/${workspaceId}/cards?archived=only&limit=${PICKER_PAGE}`) as { cards: Card[]; total?: number };
      archivedEnd.current = d.cards.length < PICKER_PAGE;
      setArchivedCards(d.cards);
      setArchivedTotal(d.total);
      setArchivedNotice(undefined);
      setMenu('archived');
    } catch (e) { note(`could not list archived cards: ${(e as Error).message}`); }
  }, [api, note]);
  // The next page, appended in place — morePicker's shape: the cursor is the
  // last loaded row, failure keeps what is loaded, scrolling again retries.
  const moreArchived = useCallback(async (workspaceId: string) => {
    const tail = archivedRef.current[archivedRef.current.length - 1];
    if (archivedEnd.current || !tail || moreArchivedInFlight.current) return;
    moreArchivedInFlight.current = true;
    try {
      const d = await api('GET', `/workspaces/${workspaceId}/cards?archived=only&limit=${PICKER_PAGE}` +
        `&before=${encodeURIComponent(tail.updated_at)}&before_id=${tail.id}`) as { cards: Card[]; total?: number };
      archivedEnd.current = d.cards.length < PICKER_PAGE;
      setArchivedTotal(d.total);
      setArchivedCards((prev) => {
        const seen = new Set(prev.map((t) => t.id));
        return [...prev, ...d.cards.filter((t) => !seen.has(t.id))];
      });
    } catch { /* keep what is loaded */ }
    finally { moreArchivedInFlight.current = false; }
  }, [api]);

  // [k] on /tasks — armed like /resume's [t]: the first press is the warning,
  // the same [k] again kills (TERM, a second, then KILL — the whole tree).
  const killTask = useCallback(async (sid: string, command: string) => {
    if (!sessionId) return;
    if (killArmed.current !== sid) {
      killArmed.current = sid;
      setTasksNotice(`kill "${command}"? — [k] again to kill`);
      return;
    }
    killArmed.current = null;
    try {
      await api('DELETE', `/sessions/${sessionId}/tasks/${sid}`);
      setTasksNotice(undefined);
      // The kill landed; a failed re-read must not report "could not kill".
      await refreshTasks().catch(() => {});
    } catch (e) {
      setTasksNotice(`could not kill: ${(e as Error).message}`);
    }
  }, [api, sessionId, refreshTasks]);

  // The launch itself — the same flow /new and /workspace run, as an effect,
  // so the window is ALREADY OPEN when anything goes wrong: the failure lands
  // as words in the pane and the screens that fix it (/keys, /settings,
  // /server) are a slash command away, never a stack trace before the
  // app exists. On success it is exactly a /new in the chosen workspace.
  const booted = useRef(false);
  useEffect(() => {
    if (!boot || booted.current) return;
    booted.current = true;
    void (async () => {
      if (boot.resumeId) { await openSession({ kind: 'open', id: boot.resumeId }); return; }
      let ws: WorkspaceInfo[];
      try { ws = await api('GET', '/workspaces') as unknown as WorkspaceInfo[]; }
      catch (e) {
        note(`could not reach the server: ${(e as Error).message}`);
        note('have a server? its address and key go under /server, then /workspace starts a session');
        note('need one? quit and run `phantom-cli setup-backend`');
        return;
      }
      // Nothing registered yet: go straight to adding one. An empty install
      // has to be able to start from here, not from curl.
      if (!ws.length) { setMenu('addWorkspace'); return; }
      if (ws.length === 1) { await openSession({ kind: 'new', workspaceId: ws[0].id }); return; }
      // boot_last_workspace (a server setting, off by default) skips the
      // picker: a new session in the workspace of the newest session you
      // drove yourself — looper-run sessions do not count.
      try {
        if ((await readCfg()).boot_last_workspace === true) {
          const ss = ((await api('GET', '/sessions')) as unknown as { sessions: SessionInfo[] }).sessions;
          const last = lastWorkspaceId(ws, ss);
          if (last) { await openSession({ kind: 'new', workspaceId: last }); return; }
        }
      } catch { /* the picker still answers */ }
      await openPicker('workspace');
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- launch only
  }, []);

  // THE close: a session leaves local memory — the tab ring, the open-session
  // list, the dot on its /resume row. Nothing on the server changes, so
  // opening it again gets it back exactly as it was. Every door ([x] on
  // /resume, /close, the Assistant's session_close) comes through here, so
  // the rules live once: refused while a turn runs there (the stream's
  // onParts closes over that entry); closing the one on screen hands the
  // screen to whatever you spoke to most recently — through switchTo, so it
  // arrives like any other switch; closing the LAST one opens a fresh session
  // in the same workspace — close means "done with this", never "leave me
  // looking at nothing". The result is facts; each door renders them where
  // its user is looking.
  type CloseResult = { ok: true; closed: string; on_screen: string; opened_new: boolean } | { error: string };
  const closeSession = useCallback(async (id?: string): Promise<CloseResult> => {
    const target = id ?? store.activeId;
    if (!target) return { error: 'no session is open — nothing to close' };
    const e = store.get(target);
    if (!e) return { error: `session ${target} is not open in this window — nothing to close` };
    const { workspaceId } = e;
    const wasOnScreen = store.activeId === target;
    if (!store.close(target)) return { error: `a turn is running in ${target} — stop it first` };
    let opened_new = false;
    if (wasOnScreen) {
      const next = store.list()[0];
      if (next) switchTo(next.id);
      else opened_new = await openSession({ kind: 'new', workspaceId });
    }
    return { ok: true, closed: target, on_screen: store.activeId, opened_new };
  }, [store, switchTo, openSession]);
  closeSessionRef.current = closeSession;

  // [x] on /resume: the result on the picker's own notice line, where the
  // list is.
  const closeFromPicker = useCallback(async (id: string) => {
    const r = await closeSession(id);
    if ('error' in r) { setPickerNotice(r.error.includes('a turn is running') ? 'a turn is running there — esc stops it, then [x]' : r.error); return; }
    setPickerNotice(r.opened_new ? 'closed the last one — a new session is open behind this list'
      : 'closed — enter opens it again');
  }, [closeSession]);

  // [t] on /resume: the session leaves the server for good — row, transcript,
  // files; only its pushed branch on origin survives. Refusals arm/say why on
  // the picker's own notice line and the list refreshes in place.
  const trashSession = useCallback(async (id: string) => {
    if (store.has(id)) { setPickerNotice('that session is open in this window'); return; }
    const force = trashArmed.current === id;
    try {
      await api('DELETE', `/sessions/${id}?purge=true${force ? '&force=true' : ''}`);
      trashArmed.current = null;
      setPickerNotice(undefined);
      // The trash landed; a failed re-read must not report "could not trash".
      await refreshPicker().catch(() => {});
    } catch (e) {
      const m = (e as Error).message;
      const code = (e as { code?: string }).code ?? '';
      if (code === 'unpushed_work' || m.includes('unpushed_work')) { trashArmed.current = id; setPickerNotice('unpushed work — [t] again to discard it'); }
      else if (code === 'session_locked' || m.includes('session_locked')) setPickerNotice('in use elsewhere — a held session cannot be trashed');
      else setPickerNotice(`could not trash: ${m}`);
    }
  }, [api, store, refreshPicker]);

  // The one voice-switch toggle — /mic /speaker /headphones /wake, ctrl+r/l,
  // and a click on either of the pane's switch rows all land here. Every
  // switch IS a setting (voice_mic_muted / voice_speaker_muted /
  // voice_headphones / voice_wake_word): the toggle writes the file and goes
  // through onConfigChange — the same path the /voice screen takes, which is
  // what keeps the screen and the toggle from diverging — and the state holds
  // across engine and TUI restarts.
  const toggleDevice = useCallback((which: 'mic' | 'speaker' | 'headphones' | 'wake') => {
    if (!voice.running) { note('voice is off — /voice to turn it on'); return; }
    const key = TOGGLE_KEY[which];
    void (async () => {
      // Read the switch, flip it, write it, then let onConfigChange read
      // everything again. A toggle is a read-modify-write, so it reads.
      const cfg = await readCfg().catch(() => null);
      if (!cfg) { note('could not read settings from the server'); return; }
      const now = !cfg[key];
      // Where a switch is saved follows where the setting lives: the mic and
      // speaker mutes and the headphones switch are facts about this machine,
      // the wake word is not.
      if (isLocalKey(key)) {
        const err = setLocal(key, now, configPath);
        if (err) { note(err); return; }
      } else {
        try { await settings.write(key, now); }
        catch (e) { note(`could not save ${key}: ${(e as Error).message}`); return; }
      }
      onConfigChange(key);
      switch (which) {
        case 'mic': note(now ? 'voice: not listening' : 'voice: listening'); break;
        case 'speaker': note(now ? 'voice: quiet — text only' : 'voice: speaking again'); break;
        case 'headphones':
          note(now ? 'voice: headphones on — talk over it'
            : 'voice: headphones off — over speakers, the mic is muted while it speaks');
          break;
        case 'wake':
          note(now ? `voice: waiting for the wake word (${String(cfg.voice_wake_words ?? '')})`
            : 'voice: wake word off — it answers everything it hears');
          break;
      }
    })();
  }, [voice, note, configPath, onConfigChange, readCfg, settings]);

  const runCommand = useCallback(async (name: string, args = '') => {
    switch (name) {
      case 'new':
        // No session yet = no workspace to mean "here": the picker chooses.
        if (session) await openSession({ kind: 'new', workspaceId: session.workspaceId });
        else await openPicker('workspace');
        return;
      case 'resume': await openPicker('resume'); return;
      case 'close': {
        // The same act as [x] on /resume, aimed at the session on screen.
        const r = await closeSession();
        if ('error' in r) { note(r.error.includes('a turn is running') ? 'a turn is running here — esc stops it, then /close' : r.error); return; }
        note(r.opened_new ? 'closed the last one — this is a new session; /resume opens the old one again'
          : 'closed — /resume opens it again');
        return;
      }
      case 'workspace': await openPicker('workspace'); return;
      case 'rename': {
        if (!session) { note('no session is open — nothing to rename'); return; }
        try {
          await api('PATCH', `/sessions/${session.id}`, { name: args || null });
          note(args ? `renamed: ${args}` : 'name cleared — auto-titles are back on');
        } catch (e) { note(`rename failed: ${(e as Error).message}`); }
        return;
      }
      case 'kanban':
        if (!session) { note('no session is open — the board belongs to a workspace; /workspace starts a session in one'); return; }
        setView('board');
        return;
      case 'archived':
        if (!session) { note('no session is open — archived cards belong to a workspace; /workspace starts a session in one'); return; }
        await openArchived(session.workspaceId);
        return;
      case 'tasks': {
        if (!session) { note("no session is open — tasks run in a session's container"); return; }
        // Refresh before opening, openPicker's shape: a failure says so and
        // stays put rather than showing an empty screen.
        try {
          await refreshTasks();
          setTasksNotice(undefined);
          killArmed.current = null;
          setMenu('tasks');
        } catch (e) { note(`could not list tasks: ${(e as Error).message}`); }
        return;
      }
      case 'plan': {
        // The switch: the server row first (the record every window reads),
        // then this window's kit. A PATCH that lands with a rebuild that
        // fails self-heals — the elsewhere-watch reads the row each poll and
        // applies it again.
        if (!session) { note('no session is open — nothing to switch'); return; }
        if (session.readonly) { note("this is the supervisor's record — read-only"); return; }
        const on = !session.planMode;
        try {
          await api('PATCH', `/sessions/${session.id}`, { plan_mode: on });
          await applyPlanMode(session.id, on);
        } catch (e) { note(`could not switch: ${(e as Error).message}`); }
        return;
      }
      case 'auto-push': {
        if (!autoPush) { note('auto-push is unavailable in this build'); return; }
        if (!session) { note('no session is open — nothing to push'); return; }
        const pushId = session.id;
        note('auto-push: starting');
        // Detached from the command handler: an auto-push can run for minutes
        // and the prompt never locks. Steps and the result land as notes.
        void (async () => {
          try {
            const r = await autoPush(pushId, (label) => note(`auto-push: ${label}`));
            if (r.result === 'pushed') note(`auto-push: landed on the base branch (${(r.sha ?? '').slice(0, 10)})`);
            else if (r.result === 'nothing') note('auto-push: nothing to push — the base branch already has it all');
            else note(`auto-push: ${r.result}${r.reason ? ` — ${r.reason}` : ''}`);
          } catch (e) { note(`auto-push failed: ${(e as Error).message}`); }
        })();
        return;
      }
      case 'settings': setMenu('settings'); return;
      case 'keys': setMenu('keys'); return;
      case 'secrets': setMenu('secrets'); return;
      case 'model': setMenu('model'); return;
      case 'server': setMenu('server'); return;
      case 'voice':
        setMenu('voice');
        // The mic/speaker pickers want names; with voice off, ask for them.
        void voice.refreshDevices();
        return;
      case 'mic': toggleDevice('mic'); return;
      case 'speaker': toggleDevice('speaker'); return;
      case 'headphones': toggleDevice('headphones'); return;
      case 'wake': toggleDevice('wake'); return;
      case 'assistant':
        if (!args) { note('/assistant <what to tell the Assistant>'); return; }
        if (!voice.say(args)) note('voice is off — /voice to turn it on');
        else setSidebar((s) => (s === false ? null : s));
        return;
      case 'help':
        note(COMMANDS.map((c) => `  /${c.name.padEnd(10)} ${c.summary}`).join('\n'));
        return;
      case 'exit': quit(); return;
    }
  }, [api, quit, openPicker, openSession, openSwitcher, session, autoPush, closeSession, note, voice, toggleDevice, applyPlanMode, openArchived]);

  const submit = useCallback(async (text: string) => {
    const msg = text.trim();
    if (!msg) return;
    // Locked elsewhere = read-only here: refuse BEFORE the box clears, so
    // the typed line stays put to edit or resend. Slash commands still run —
    // they are the window's, not the session's.
    if (heldRef.current && !msg.startsWith('/') && msg !== 'exit' && msg !== 'quit') {
      note(`not sent — a turn is running (${heldRef.current.label})`);
      return;
    }
    setInput('');
    setHistAt(0);
    setScroll(0);
    setSplash(false);   // commands too: /help answers into the pane the splash covers
    if (msg === 'exit' || msg === 'quit') { quit(); return; }
    if (msg.startsWith('/')) {
      // The list is showing with a row highlighted, so enter takes THAT row —
      // arrowing to a command and pressing enter has to run it, not submit the
      // half-typed text that produced the list.
      const m = matches(msg);
      if (m.length) { setSuggestAt(0); await runCommand(m[Math.min(suggestAt, m.length - 1)].name); return; }
      // No menu: either an argument follows the command (`/assistant hello`) or
      // nothing matched. parse() tells the two apart.
      const { command, args, error } = parse(msg);
      if (command) { await runCommand(command.name, args); return; }
      note(error ?? `unknown command ${msg}`);
      return;
    }
    // No session on screen: the words have no conversation to land in. Say
    // where to get one instead of dropping them silently.
    if (!session) { note('no session is open — /workspace starts one, /resume reopens an earlier one'); return; }
    // A supervisor session is the looper's record — read it, never chat into it.
    if (session.readonly) { note("this is the supervisor's record — read-only"); return; }
    // Addressed to the session that is on screen, and it keeps running there
    // whether or not you stay to watch it. Typed while it is already running,
    // it waits its turn — shown under the live output until then.
    store.say(session.id, msg);
  }, [store, session, quit, runCommand, suggestAt, note]);

  /** What you have said to this session, oldest first. Straight off the history
   *  already in memory — nothing is stored a second time for this. */
  const said = useMemo(() => {
    const out: string[] = [];
    for (const m of session?.history ?? []) {
      if (m.role !== 'user') continue;
      const text = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((c) => (c as { type?: string }).type === 'text')
              .map((c) => (c as { text?: string }).text ?? '').join('')
          : '';
      if (text.trim()) out.push(text.trim());
    }
    return out;
  }, [session?.history, session?.done]);

  /** Walk back (-1) and forward (+1) through them. Only from an empty line or
   *  while already browsing: ↑ must not silently destroy something typed. */
  const recall = useCallback((dir: -1 | 1) => {
    if (!said.length) return;
    const next = Math.min(said.length, Math.max(0, histAt - dir));
    setHistAt(next);
    setInput(next === 0 ? '' : said[said.length - next]);
  }, [said, histAt]);

  // ctrl+c is the one key that has to work from anywhere — it is how you get
  // out. The handler below is switched off while a menu is open (esc must not
  // close the menu AND interrupt the turn in one stroke), which left ctrl+c
  // unhandled on every menu screen, because the app runs with exitOnCtrlC
  // false and nothing else listens for it. So it gets its own handler that is
  // never gated, and the gated one no longer mentions it — Ink fans a keypress
  // to every active handler, so the two must not both claim it.
  //
  // It interrupts the session you are LOOKING at. A turn running in another
  // one is not something this key can see, and stopping work you cannot see is
  // not what "cancel" means here.
  // The mouse (mouse.ts). Never gated — it works over menus too. Wheel scrolls
  // the pane under the cursor; press/drag/release is a selection in the pane
  // it started in, highlighted through the screen mirror and copied to the
  // clipboard on release — nothing to press. Every other handler ignores
  // these strings (TextInput asks isMouseInput; the rest act on key flags).
  useInput((ch) => {
    if (!isMouseInput(ch)) return;
    const ev = parseMouse(ch);
    // With the board up, the left pane's mouse belongs to it (drag moves a
    // card, click opens one) — running text selection there too would copy on
    // every drop. The voice pane keeps its wheel and selection.
    if (view !== 'chat' && ev && !(showSidebar && ev.x >= mainCols)) return;
    if (!ev) return;
    const inVoice = showSidebar && ev.x >= mainCols;
    if (ev.kind === 'wheel') {
      if (ev.button === 0) return;
      const step = 3 * ev.button;   // +down scrolls toward the tail (offset shrinks)
      scrollBy(inVoice ? 'voice' : 'chat', -step);
      return;
    }
    if (ev.button !== 0) return;   // left button only
    if (ev.kind === 'press') {
      const region = inVoice ? { left: mainCols + 1, right: screenCols - 1 } : { left: 0, right: mainCols - 1 };
      selection.current = { anchor: { x: ev.x, y: ev.y }, head: { x: ev.x, y: ev.y }, region };
      screen?.highlight(null);
      return;
    }
    const sel = selection.current;
    if (!sel) return;
    sel.head = { x: ev.x, y: ev.y };
    const ranges = selectionRanges(sel);
    if (ev.kind === 'drag') { screen?.highlight(ranges); return; }
    // release
    const moved = sel.anchor.x !== sel.head.x || sel.anchor.y !== sel.head.y;
    selection.current = null;
    if (!moved || !screen) { screen?.highlight(null); return; }
    const text = screen.textOf(ranges).join('\n').trim();
    screen.highlight(null);
    if (!text) return;
    void copyToClipboard(text).then(() => note(`copied ${text.length} characters`));
  });

  // Mic and speaker toggles, always on — like ctrl+c they must work from the
  // board, a menu, anywhere. ctrl+r (record) and ctrl+l (loudspeaker): both in
  // the set this terminal actually delivers (`npm run keys`).
  useInput((ch, key) => {
    if (!key.ctrl || (ch !== 'r' && ch !== 'l')) return;
    toggleDevice(ch === 'r' ? 'mic' : 'speaker');
  });

  useInput((ch, key) => {
    if (!(key.ctrl && ch === 'c')) return;
    if (ctrlC) { quit(); return; }
    if (session?.busy) store.abortTurn(session.id);
    // Break out of whatever is on screen first: the second press then lands on
    // the prompt, where the toolbar is showing what it will do.
    if (menu !== null) setMenu(null);
    setCtrlC(true); setTimeout(() => setCtrlC(false), 1500);
  });

  // Off while a menu owns the keyboard — see the note at the top of the file.
  useInput((ch, key) => {
    // esc while a turn runs: with something queued, the first press drops the
    // queue and the turn keeps going (what you said next was the mistake, not
    // what is running); the next press stops the turn.
    if (key.escape && session?.busy) {
      if (session.queue.length) store.clearQueue(session.id);
      else store.abortTurn(session.id);
      return;
    }
    if (key.ctrl && ch === 'o') { setExpanded((e) => !e); return; }
    if (key.ctrl && ch === 'g') { setSidebar(!showSidebar); return; }
    // Scroll the conversation, through the same rule the wheel uses. A page is
    // most of the pane.
    const page = Math.max(1, screenRows - liveRows - 4);
    if (key.pageUp) { scrollBy('chat', page); return; }
    if (key.pageDown) { scrollBy('chat', -page); return; }
    // ctrl+n, THE way to the list of open sessions, and the only one. Chosen
    // by pressing keys on a real Mac (`npm run keys`): Apple Terminal sends
    // shift+↑ as a plain ↑, and ctrl+x never reached the terminal at all —
    // something on the machine took it first. ctrl+n arrived. shift+↑ was a
    // second door for the terminals that send it, and it is gone: a shortcut
    // that works on some machines and silently does history on the rest is a
    // key nobody can learn.
    if (key.ctrl && ch === 'n') { openSwitcher(); return; }

    // A slash line is being typed, so tab completes it and the arrows walk the
    // suggestions — that is what they mean while that list is up, and only
    // then. shift+tab is left alone here rather than cycling mid-command.
    const m = matches(input);
    const suggesting = m.length > 0 && !session?.busy;
    if (suggesting) {
      if (key.tab && !key.shift) {
        setInput((cur) => complete(cur, suggestAt < m.length ? suggestAt : undefined));
        setSuggestAt(0);
      } else if (key.downArrow && !key.shift) setSuggestAt((i) => (i + 1) % m.length);
      else if (key.upArrow && !key.shift) setSuggestAt((i) => (i - 1 + m.length) % m.length);
      return;
    }

    // Everywhere else tab is the session ring — including while a turn runs,
    // which is the whole point of having more than one open.
    if (key.tab) { cycle(key.shift ? -1 : 1); return; }
    // ↑ on an empty line while a turn runs and something is queued: take the
    // last queued line back into the box — that is how you fix what you said
    // too soon. Older history is one more ↑ away once the queue is empty.
    if (key.upArrow && input === '' && histAt === 0 && session?.queue.length) {
      setInput(store.unqueue(session.id) ?? '');
      return;
    }
    if (key.upArrow && (histAt > 0 || input === '')) { recall(-1); return; }
    if (key.downArrow && histAt > 0) { recall(1); return; }
  }, { isActive: menu === null && view === 'chat' });

  const suggestions = matches(input);
  const at = Math.min(suggestAt, Math.max(0, suggestions.length - 1));
  // The menu shows a window of MENU_ROWS rows and slides it so the highlighted
  // row is always one of them — the list will only grow, and an arrow key must
  // never land on a row that is not on screen.
  const menuFrom = Math.max(0, Math.min(at - MENU_ROWS + 1, suggestions.length - MENU_ROWS));
  const menuRows = suggestions.slice(menuFrom, menuFrom + MENU_ROWS);
  const menuAbove = menuFrom;
  const menuBelow = suggestions.length - menuFrom - menuRows.length;

  // The toolbar's mode mark — ALWAYS on while a session is on screen: the
  // line says which mode you are in before you type, '» plan mode' or
  // '» code mode', riding in front of whatever else it says. A supervisor
  // record has no modes — you cannot chat there at all.
  const modeMark = session && !session.readonly
    ? (session.planMode ? '» plan mode on' : '» code mode on')
    : undefined;
  // The task count rides beside the mode on EVERY session branch — always
  // visible, `0 tasks` included (a status that appears only when non-zero
  // reads as a notice, not a state). Null only before the first fetch lands.
  const taskMark = session && taskCount != null
    ? `${taskCount} task${taskCount === 1 ? '' : 's'}`
    : undefined;
  // Which card this session is building, when it is building one — the
  // board's own name for it (`PHA-7`), so the line you read while typing
  // answers "what am I working on" without opening anything. Nothing shows
  // for a session you started yourself: no card is a state, not a warning.
  const cardMark = session?.card;
  const withMode = (rest?: string) =>
    [modeMark, taskMark, cardMark, rest].filter(Boolean).join(' · ') || undefined;

  return (
    <SizeContext.Provider value={{ rows: screenRows, cols: screenCols }}>
    <Box flexDirection="row" width={repaint ? 0 : screenCols} height={repaint ? 0 : screenRows} overflow="hidden">
    <Box flexDirection="column" width={mainCols} height={screenRows} overflow="hidden">
      {view !== 'chat' && session ? (
        <Boundary name="board" resetKey={view} onError={(m) => { note(`${m} — the board closed; the stack is in ~/.phantom-cli/cli.log`); setView('chat'); }}>
        <Board store={boardFor(session.workspaceId)} width={mainCols} height={screenRows}
          isActive solo={typeof view === 'object' ? view.card : undefined}
          onClose={() => setView('chat')}
          // The card editor's Session row: back to chat, then the one open
          // path — already loaded switches, otherwise it opens (read-only
          // while the looper holds it, like /resume).
          onOpenSession={(id) => { setView('chat'); void openSession({ kind: 'open', id }); }}
          onArchived={() => { setView('chat'); void openArchived(session.workspaceId); }} />
        </Boundary>
      ) : (<>
      {/* keyFor: a part's own id, so the height the pane measured for it
          survives the list being rebuilt (a refresh reseats the whole
          conversation) and switching between sessions. */}
      <Boundary name="conversation" resetKey={session?.id} onError={(m) => note(`${m} — the conversation stopped drawing; /resume it to redraw; the stack is in ~/.phantom-cli/cli.log`)}>
      <Pane items={session ? session.done : windowNotes} offset={scroll} width={mainCols} onMeasure={setScrollMax} topGap
        keyFor={(p) => p.id}
        render={(p) => <PartView key={p.id} part={p} width={width} expanded={expanded} />}
        // The splash rides the pane's empty space so the header stays put:
        // clearing it blanks only the banner's own rows — the pane-swap
        // version replaced 21 rows of the screen in one frame (traced).
        fill={splash ? <Banner width={mainCols} /> : undefined} />
      </Boundary>
      <Box ref={bottomRef} flexDirection="column" flexShrink={0}>
        {session?.live.map((p) => (
          <PartView key={p.id} part={p} width={width} expanded={expanded} maxRows={liveRows} />
        ))}
        {/* The working line, for OUR turn and for one we are watching. A tool
            row does not animate on its own, so without this a two-minute
            remote `bash` looks like a frozen screen. Watching it carries no
            esc hint: esc cannot stop someone else's turn, and offering it
            would be a lie. */}
        {(session?.busy || session?.remoteBusy) && <StatusLine phase={phaseLabel(session.live)}
          startedAt={session.startedAt} tokens={tokenCount(session.tokens)}
          escHint={!session.busy ? undefined
            : session.queue.length ? '[esc] clears the queue, then interrupts' : '[esc] to interrupt'} />}
        {session && session.queue.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{`  queued · sent together, in one turn, when this one ends`}</Text>
            {session.queue.map((q, i) => (
              <Text key={i} dimColor>{`  › ${q}`}</Text>
            ))}
          </Box>
        )}

        <Boundary name={menu ?? 'prompt'} resetKey={menu} onError={(m) => { note(`${m} — ${menu ? `/${menu} closed` : 'the prompt stopped drawing'}; the stack is in ~/.phantom-cli/cli.log`); setMenu(null); }}>
        {menu === 'sessions' ? (
          <SessionSwitcher
            sessions={store.list()} activeId={sessionId ?? ''} workspaces={names}
            onPick={(id) => { setMenu(null); switchTo(id); }}
            onCancel={() => setMenu(null)}
          />
        ) : menu === 'settings' ? (
          // The server's own settings; the screen's sub line says the scope.
          <Settings api={api} configPath={configPath} startAt="api"
            onClose={() => setMenu(null)} />
        ) : menu === 'keys' ? (
          // Its own screen so there is ONE place any credential is set — not
          // because these are a different kind of thing any more. A saved key
          // has to reach the app like any other setting change: the Assistant
          // takes its Deepgram key at spawn, and the agents take theirs at
          // build.
          <Keys api={api} onClose={() => setMenu(null)}
            onChanged={(name) => onConfigChange(name as ConfigKey)} />
        ) : menu === 'secrets' ? (
          // The agent's secrets, not phantom's own credentials (/keys). The
          // screen reads every layer itself — no session context needed.
          <Secrets api={api} onClose={() => setMenu(null)} />
        ) : menu === 'workspaceSettings' && editing ? (
          <WorkspaceSettings
            api={api} workspace={editing}
            // Back to the list it was opened from, refreshed — a rename there
            // has to show up here.
            onClose={() => { setEditing(null); void openPicker('workspace'); }}
            onChanged={() => { void refreshPicker().catch(() => {}); }}
          />
        ) : menu === 'voice' ? (
          // The Assistant's settings — local, offline. Device rows offer
          // what the sidecar found; saving a boot-time key restarts it.
          <Settings api={api} configPath={configPath} startAt="local"
            title="voice" groups={['voice']}
            suggestions={{ voice_mic_device: vs.devices.mics, voice_speaker_device: vs.devices.speakers }}
            onOpenRow={(k) => { if (k === 'voice_mic_device' || k === 'voice_speaker_device') void voice.refreshDevices(); }}
            onLocalChange={onConfigChange} onClose={() => setMenu(null)} />
        ) : menu === 'model' || menu === 'server' ? (
          // /server is the ONE screen that must work with the server down — it
          // is where you fix the address — so it gets the offline api and its
          // two keys are the two that live in the file. /model writes to the
          // server like every other setting screen.
          <Settings api={menu === 'server' ? offline : api} configPath={configPath} startAt="local"
            title={menu} groups={[menu === 'model' ? 'model' : 'server']}
            onLocalChange={onConfigChange} onClose={() => setMenu(null)} />
        ) : menu === 'addWorkspace' ? (
          <NewWorkspace
            api={api}
            error={addError}
            onCancel={() => setMenu(null)}
            onSubmit={async (req: NewWorkspaceRequest) => {
              // Cleared before the call so a second failure with the SAME
              // message is still a change of the error prop — the form's
              // recovery effect keys on it.
              setAddError(undefined);
              try {
                const w = await api('POST', '/workspaces', req) as { id: string; owner: string; name: string };
                setMenu(null);
                // Adding one is only useful if you then work in it. The
                // confirmation goes AFTER the switch, into the session you land
                // in: noting it first writes it to the session you are leaving,
                // where the switch immediately wipes it off screen unread.
                await openSession({ kind: 'new', workspaceId: w.id });
                note(`workspace ${w.owner}/${w.name} added`);
              } catch (e) {
                // Stay on the form with the server's own words — it distinguishes
                // already_exists from a token that cannot create.
                setAddError((e as Error).message.replace(/^POST \/workspaces: /, ''));
                setMenu('addWorkspace');
              }
            }}
          />
        ) : menu === 'archived' && session ? (
          <Archived cards={archivedCards} notice={archivedNotice}
            onNearEnd={() => { void moreArchived(session.workspaceId); }}
            total={archivedTotal}
            // The solo editor renders from the store, which never holds
            // archived cards on its own — seat this one first.
            onOpen={(t) => { boardFor(session.workspaceId).adoptCard(t); setMenu(null); setView({ card: t.seq }); }}
            onRestore={(t) => {
              void (async () => {
                try {
                  await api('PATCH', `/workspaces/${session.workspaceId}/cards/${t.id}`, { archived: false });
                  setArchivedCards((prev) => prev.filter((x) => x.id !== t.id));
                  setArchivedNotice(`restored ${t.seq}-${t.title} → ${t.status.replace(/_/g, ' ')}`);
                  void boardFor(session.workspaceId).load(); // the card is back on the board
                } catch (e) { setArchivedNotice(`restore failed: ${(e as Error).message}`); }
              })();
            }}
            onCancel={() => setMenu(null)} />
        ) : menu === 'tasks' && tasksView ? (
          <Tasks view={tasksView} notice={tasksNotice}
            onKill={(sid, cmd) => { void killTask(sid, cmd); }}
            onCancel={() => setMenu(null)} />
        ) : (menu === 'workspace' || menu === 'resume') && picker ? (
            <Launcher
              mode={menu === 'resume' ? 'sessions' : 'workspaces'}
              workspaces={picker.workspaces} sessions={picker.sessions} total={picker.total}
              showSupervised={showSupervised}
              onToggleSupervised={() => {
                setShowSupervised((x) => !x);
                showSupervisedRef.current = !showSupervised;
                void refreshPicker(true).catch(() => {});
              }}
              lastMessage={lastUserMessage}
              busy={(id) => store.get(id)?.busy ?? false}
              loaded={(id) => store.has(id)}
              clientId={clientId}
              notice={pickerNotice}
              onNearEnd={menu === 'resume' ? () => { void morePicker(); } : undefined}
              onEdit={(id) => {
                const w = picker.workspaces.find((x) => x.id === id);
                if (!w) return;
                setEditing(w); setMenu('workspaceSettings');
              }}
              onDuplicate={(id) => {
                setMenu(null);
                void openSession({ kind: 'duplicate', id });
              }}
              onClose={closeFromPicker}
              onTrash={(id) => { void trashSession(id); }}
              onCancel={() => setMenu(null)}
              onPick={(l) => {
                if (l.kind === 'add') { setAddError(undefined); setMenu('addWorkspace'); return; }
                setMenu(null);
                void openSession(l.kind === 'new'
                  ? { kind: 'new', workspaceId: l.workspaceId }
                  : { kind: 'open', id: l.sessionId });
              }}
            />
        ) : (
          <>
            {suggestions.length > 0 && (
              // One height however many commands match. The menu sits under a
              // bottom-anchored pane, so a box that resized as the list
              // narrowed shifted the whole conversation on every keystroke —
              // measured at 25 of 30 screen rows rewritten per letter, the
              // flicker on terminals without synchronized output. Every slot
              // renders (blank when unused), so filtering rewrites only the
              // rows that actually changed. Blank rows under a short list are
              // the price of a screen that holds still.
              <Box flexDirection="column" marginTop={1} marginBottom={1}>
                <Text dimColor>{menuAbove > 0 ? `    ↑ ${menuAbove} more` : ' '}</Text>
                {Array.from({ length: MENU_ROWS }, (_, j) => {
                  const c = menuRows[j];
                  if (!c) return <Text key={`pad${j}`}> </Text>;
                  const i = menuFrom + j;
                  return (
                    // truncate-end keeps a row ONE line on a narrow terminal —
                    // a wrapped summary would break this menu's fixed height.
                    <Text key={c.name} color={i === at ? 'cyan' : undefined} dimColor={i !== at} wrap="truncate-end">
                      {`${i === at ? '❯ ' : '  '}/${c.name.padEnd(10)} ${c.summary}`}
                    </Text>
                  );
                })}
                <Text dimColor>{menuBelow > 0 ? `    ↓ ${menuBelow} more` : ' '}</Text>
                <Text dimColor wrap="truncate-end">{`    ${keyLine([
                  { key: 'tab', does: 'complete' }, { key: '↑↓', does: 'choose' }, { key: 'enter', does: 'run' },
                ])}`}</Text>
              </Box>
            )}
            <Prompt value={input} onChange={(v) => { setInput(v); setSuggestAt(0); }}
              onSubmit={submit} onMeasure={setPromptTop} />
            <Toolbar
              // Held elsewhere: the marks, then WHO is working, the spinner,
              // and WHAT they are doing — `coding agent ⠹ building`. No
              // sentence about being locked out: the spinner says something
              // is running, and typing says the rest.
              spin={session && !session.busy && heldNow ? heldNow.label : undefined}
              spinWho={session && !session.busy && heldNow ? heldNow.who : undefined}
              notice={
              ctrlC ? withMode('press ctrl+c again to quit')
              : !session
                ? 'no session open — [/workspace] starts one · [/resume] reopens an earlier one'
                : withMode()} />
          </>
        )}
        </Boundary>
      </Box>
      </>)}
    </Box>
    {showSidebar && <Divider rows={screenRows} junctions={junctions} />}
    {showSidebar && <Boundary name="voice pane" resetKey={showSidebar} onError={(m) => note(`${m} — the voice pane stopped drawing; /voice off and on redraws it; the stack is in ~/.phantom-cli/cli.log`)}>
      <VoicePanel width={sideCols - 1} voice={vs} expanded={expanded}
      offset={voiceScroll} onMeasure={setVoiceScrollMax} onDevice={toggleDevice}
      approval={approval} onApproval={(ok) => approvalRef.current?.resolve(ok)} />
    </Boundary>}
    </Box>
    </SizeContext.Provider>
  );
}

/** Compare the server's transcript stamp with what memory matches; when it
 *  moved, pull the transcript and reseat — the ONE way work done elsewhere
 *  (another window, a looper round) reaches this screen. Used at turn start
 *  (off the lock response), on switch, and by the elsewhere-watch poll.
 *  `server` is the stamp the caller already holds; null means don't look. */
async function reseatIfMoved(api: Api, store: SessionStore, id: string, server: string | null,
  keepScreen = false): Promise<void> {
  const cur = store.get(id);
  if (!cur || cur.busy || !server || server === cur.syncStamp) return;
  const t = await api('GET', `/sessions/${id}/transcript`) as { data: string | null; updated_at?: string | null };
  // Same seating rule as open: a local file that is the server's text plus
  // unsaved steps is kept and shipped; the screen shows the fuller copy.
  const seated = adoptServerCopy(id, t.data);
  const parsed = parseTranscript(seated.text);
  if (seated.localKept) void syncTranscriptUp(api, id).then((stamp) => store.setStamp(id, stamp), () => {});
  // keepScreen: the session feed showed us this whole turn as it happened, so
  // the record brings the history and the stamp and the screen keeps what it
  // drew — richer than a transcript replay (which carries no thinking and no
  // tool timings), and no repaint to jump through. The note would be a lie
  // there too: nothing moved forward unseen.
  store.reseat(id, parsed.messages, keepScreen ? null : [
    { kind: 'note', id: nextId('note'), text: 'refreshed — this session moved forward elsewhere' } as Part,
    ...messagesToParts(parsed.messages),
  ], t.updated_at ?? server);
}

