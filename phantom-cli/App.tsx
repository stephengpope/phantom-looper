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
// running turn in the same stroke. While a menu is open the live-output
// region above it (streaming parts, the working line, the queue) is not
// drawn at all: its height changes with every token batch, and the menu sits
// BELOW it in the same bottom-anchored block, so every change rode the whole
// menu up and down — the /resume flicker. The stream itself is untouched;
// closing the menu redraws the region from the store mid-turn.
//
// SEVERAL SESSIONS AT ONCE. Every session you open stays open and keeps
// running; this component is a view over whichever one is active. The
// conversations live in `sessions.ts`, outside React, because a turn streaming
// in a session you are not looking at cannot write into component state that
// belongs to the session you are.
//
// Keys: enter submit (queues while a turn runs) · esc interrupt (skip to next when queued) · tab/shift+tab next/previous session ·
// ctrl+n the session list · ↑/↓ what you said before · ctrl+o show more
// (thinking, and a tool's whole command and output) · ctrl+g the voice pane ·
// ctrl+r mic · ctrl+l speaker (both work
// anywhere, the board included) · pageUp/pageDown scroll the conversation ·
// ctrl+c clears the line; on an empty line twice to quit.
import { Box, useApp, useBoxMetrics, useInput, useWindowSize } from 'ink';
import { Text } from './components/Text.js';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ModelMessage, Tool } from 'ai';
import { runTurn } from './agent.js';
import { buildAgent, buildAssistantAgent } from './agentFromConfig.js';
import { phaseLabel, tokenCount, formatTokensOut } from './state.js';
import { activeHold } from './sessions.js';
import { Transcript, lastUserMessage, type TranscriptHeader } from './session.js';
import { complete, matches } from './commands.js';
import { quiet, type Api } from './request.js';
import { WindowStore, type Initial } from './window.js';

export type { Initial };

/** Rows the slash windowStore.menu shows at once; the window slides to follow the cursor. */
const MENU_ROWS = 8;
import { PartView } from './components/Parts.js';
import { Prompt } from './components/Prompt.js';
import { StatusLine } from './components/StatusLine.js';
import { Toolbar, type ToolbarGroup, type ToolbarPart } from './components/Toolbar.js';
import { Settings } from './components/Settings.js';
import { Launcher, ago, WORK } from './components/Launcher.js';
import { NewWorkspace, type NewWorkspaceRequest } from './components/NewWorkspace.js';
import { WorkspaceSettings } from './components/WorkspaceSettings.js';
import { SessionSwitcher } from './components/SessionSwitcher.js';
import { Keys } from './components/Keys.js';
import { Tasks } from './components/Tasks.js';
import { Archived } from './components/Archived.js';
import { Secrets } from './components/Secrets.js';
import { Presets } from './components/Presets.js';
import { DuplicateModel } from './components/DuplicateModel.js';
import { SizeContext, keyLine } from './components/Screen.js';
import { Pane } from './components/Pane.js';
import { Boundary } from './components/Boundary.js';
import { Banner } from './components/Banner.js';
import { VoicePanel } from './components/VoicePanel.js';
import { Divider } from './components/Divider.js';
import { VoiceClient } from './voice.js';
import { BoardStore, type Stream } from './board.js';
import { Board } from './components/Board.js';
import { type ConfigKey, type ConfigValue } from './config.js';

import { copyToClipboard, isMouseInput, parseMouse, selectionRanges, type Selection } from './mouse.js';
import type { Screen } from './screen.js';
import type { GitFacts } from '../core/llm/prompts/coding/wiring.js';

/** What the window remembers about a workspace: the banner's display name and
 *  the prefix its cards are named with (`PHA` → `PHA-7`). */
interface WsFacts { label: string; cardPrefix?: string; error?: string }

type Menu = null | 'settings' | 'keys' | 'secrets' | 'model' | 'server' | 'voice' | 'workspace' | 'resume'
  | 'addWorkspace' | 'workspaceSettings' | 'sessions' | 'tasks' | 'archived' | 'presets' | 'duplicateModel';

const offline: Api = async () => ({});

/** Each voice switch is a setting — the toggle writes it and windowStore.settingChanged
 *  pushes it to the engine, so the state holds across restarts. */
const TOGGLE_KEY: Record<'mic' | 'speaker' | 'headphones' | 'wake', ConfigKey> = {
  mic: 'voice_mic_muted', speaker: 'voice_speaker_muted',
  headphones: 'voice_headphones', wake: 'voice_wake_word',
};

/** /resume's page size: what the windowStore.picker fetches at open and appends per
 *  scroll-to-the-bottom. Comfortably more than a screenful, small enough that
 *  a list of thousands never rides one response. */
export const PICKER_PAGE = 30;

export function App({
  api, stream, initial, boot, newTools, configPath, onSession, bootConfig,
  autoPush,
  autoPull,
  clientId = '',
  pollMs = 10_000,
  taskPollMs = 60_000,
  makeAgent = buildAgent,
  makeTranscript = (h: TranscriptHeader) => new Transcript(h),
  run = runTurn,
  sidebarPercent = 20,
  makeVoice,
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
  /** POST /git/auto-pull for one session, the same shape — the Assistant's
   *  `git_auto_pull`. index.tsx wires core's client; absent in tests. */
  autoPull?: (sessionId: string, onStep?: (label: string) => void) =>
    Promise<{ result: string; reason?: string; arrived?: string[]; files?: string[]; sha?: string; pushed?: boolean }>;
  /** This window's session-lock id (index.tsx mints one per process and sends
   *  it as x-phantom-looper-client). The launcher uses it so this window's own held
   *  sessions do not read "in use". Empty in tests. */
  clientId?: string;
  /** How often the open /resume and /tasks lists refresh. Session state on
   *  screen follows the live feed, not this clock. Test seam. */
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

  // The screen audit (cursorAudit.ts) caught the terminal and Ink's model
  // disagreeing about where the cursor is — a wrap the width math missed.
  // Heal exactly the way a resize does: one collapsed frame, then the next
  // frame written whole.
  useEffect(() => {
    if (!screen) return;
    screen.onDrift = () => setRepaint(true);
    return () => { screen.onDrift = undefined; };
  }, [screen]);

  // THE WINDOW (window.ts): the sessions, the boards, the Assistant, and what
  // is on screen — everything with a caller that is not a React event. Built
  // in the initialiser, like the session store it replaces, so the banner is
  // on screen for the first frame. This component is a view over it.
  const [windowStore] = useState(() => new WindowStore({
    api, stream, newTools, configPath, bootConfig, initial, boot,
    makeAgent, makeTranscript, run, makeVoice, onSession, exit,
    autoPush, autoPull, clientId, pollMs, taskPollMs,
    makeAssistantAgent, newAssistantTools, sidebarPercent,
  }));
  const store = windowStore.sessions;
  const voice = windowStore.voice;
  // The window is mutable and lives outside React; this is the re-render
  // signal. One subscription: the window forwards what its parts say.
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => windowStore.subscribe(bump), [windowStore]);
  useEffect(() => () => windowStore.close(), [windowStore]);
  const vs = voice.snapshot();
  // The voice pane, on the right. Shown when voice is on; ctrl+g overrides
  // that either way. Its share of the width is a setting (percent).
  const showSidebar = windowStore.showSidebar;
  const sidePercent = windowStore.sidebarWidth;
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

  // The session on screen — or NONE. The window opens whatever is wrong (that
  // is the point: the screens that fix a dead token or a bad address are all
  // in here), so every consumer below tolerates the empty state and the pane
  // shows the window's own notes until the first session joins.
  const session = store.active();
  const sessionId = session?.id;

  // A session someone else is RUNNING — the lock is per turn, so locked =
  // a turn is live there (a looper round, another window) — is read-only
  // here. WHO holds it comes off the feed (`session.held`, the feed's `lock`
  // records: first thing on connect, then every change) and lapses on this
  // window's clock at the hold's expiry, so a holder that died without
  // releasing does not spin here for ever. The feed also carries mode, git
  // state and transcript stamps; reconnecting refills anything missed. The
  // send-time server lock refusal is the backstop for concurrent writers.
  // `activeHold` (sessions.ts) is THE one answer to "is someone working":
  // the expiry clock OR observed activity — when this expression lived here
  // alone, the send guard in the window answered differently, and a lapsed
  // clock waved a message through that the server then refused.
  const heldNow = activeHold(session);
  const heldRef = useRef(heldNow);
  heldRef.current = heldNow;
  // Streamless callers get a one-shot fill. With a feed, its initial snapshot
  // does this job: a parallel GET could land late and overwrite newer state.
  useEffect(() => {
    if (!sessionId || stream) return;
    void windowStore.recheckSession(sessionId);
  }, [windowStore, sessionId, stream]);
  // The session feeds — one per OPEN session, lock/agent/mode/git and
  // transcript state alongside live turn parts — are the window's: it opens
  // one as a session joins and closes it as the session leaves
  // (window.ts's watchSession). Nothing here follows the eye.

  // The countdown repaints once a second, only while someone else holds it
  // — and it is what notices the hold lapsing on this window's clock.
  useEffect(() => {
    if (!heldNow) return;
    const t = setInterval(bump, 1000);
    t.unref?.();
    return () => clearInterval(t);
  }, [heldNow !== null]);

  // The Assistant's read tools follow the session on screen.
  useEffect(() => { void windowStore.rebuildAssistant(); }, [windowStore, sessionId]);


  // The chrome's two values and the voice decision, from one read at launch.
  // Nothing is torn down here: windowStore.close() owns every shutdown.
  useEffect(() => { void windowStore.readChrome(); }, [windowStore]);

  const [expanded, setExpanded] = useState(false);   // ctrl+o toggles it
  const [input, setInput] = useState('');
  // The prompt's text as a ref — read by switchTo and openSession to save the
  // draft without adding `input` to their dependency arrays (which would
  // recreate the callbacks on every keystroke). Same rule as heldRef/workspaceRef.
  const inputRef = useRef(input);
  inputRef.current = input;
  // What the window asks for when it parks the unsent text on a session it is
  // leaving. Set once: the ref is stable, so the window always reads the
  // current line without this component re-registering anything.
  useEffect(() => { windowStore.draftOnScreen = () => inputRef.current; }, [windowStore]);
  // /pop injects the popped message into the prompt for editing.
  useEffect(() => { windowStore.setPrompt = (text: string) => setInput(text); }, [windowStore]);
  // The session on screen changed (a switch, an open, a close). The window
  // parked the outgoing session's unsent text on its entry; this brings the
  // incoming one's back and puts the view at the tail of its conversation.
  // Both belong here rather than in the window: they are what the VIEW does
  // when the conversation under it is replaced.
  useEffect(() => {
    setInput(store.get(store.activeId)?.draft ?? '');
    setScroll(0);
    setHistAt(0);
  }, [store, store.activeId]);
  const [ctrlC, setCtrlC] = useState(false);
  // The launch splash: the big PHANTOM LOOPER where the conversation will be.
  // Sessions with nothing said yet — boot's first, every /new — a resume has
  // history to show. Off at boot when resuming (boot.resumeId), so the
  // ghost never flashes before the transcript arrives. Cleared by the first
  // interaction that wants the screen back: a submitted line (message or
  // command — /help's answer lands in the pane the splash covers), a session
  // switch, a note, a menu or the board opening, or a remote turn arriving.
  // Set back only where openSession seats an empty session.
  useEffect(() => { if (session?.remoteBusy) windowStore.setSplash(false); }, [session?.remoteBusy]);
  const [suggestAt, setSuggestAt] = useState(0);
  // ↑/↓ through what you said before. 0 is "not browsing" — and browsing only
  // ever starts from an empty line, so there is no half-typed line to save and
  // hand back: ↓ off the end of the list lands on the empty line it started on.
  const [histAt, setHistAt] = useState(0);

  // Blank the prompt — the one rule for it: the text, the history cursor and
  // the slash-menu highlight go together (submit and ctrl+c both use it).
  const clearInput = useCallback(() => { setInput(''); setHistAt(0); setSuggestAt(0); }, []);

  // Launch, once. The window is already drawn when it runs, so a failure is
  // words in the pane rather than a stack trace before the app exists.
  useEffect(() => { void windowStore.boot(); }, [windowStore]);

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
  //
  // With text on the prompt it does one thing only: blank the line. Typing is
  // editing, not cancelling — the turn keeps running (esc is its key) and
  // nothing arms. Claude Code's rule, and the one its users asked back for
  // when a release broke it (anthropics/claude-code#17754). Only while the
  // prompt is on screen: under a menu or the board, ctrl+c still means "out".
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
    if (windowStore.view !== 'chat' && ev && !(showSidebar && ev.x >= mainCols)) return;
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
    void copyToClipboard(text).then(() => windowStore.note(`copied ${text.length} characters`));
  });

  // Mic and speaker toggles, always on — like ctrl+c they must work from the
  // board, a menu, anywhere. ctrl+r (record) and ctrl+l (loudspeaker): both in
  // the set this terminal actually delivers (`npm run keys`).
  useInput((ch, key) => {
    if (!key.ctrl || (ch !== 'r' && ch !== 'l')) return;
    windowStore.toggleDevice(ch === 'r' ? 'mic' : 'speaker');
  });

  useInput((ch, key) => {
    if (!(key.ctrl && ch === 'c')) return;
    if (windowStore.menu === null && windowStore.view === 'chat' && input) { clearInput(); return; }
    if (ctrlC) { windowStore.quit(); return; }
    if (session?.busy) store.abortTurn(session.id);
    // Break out of whatever is on screen first: the second press then lands on
    // the prompt, where the toolbar is showing what it will do.
    if (windowStore.menu !== null) windowStore.setMenu(null);
    setCtrlC(true); setTimeout(() => setCtrlC(false), 1500);
  });

  // Remote interrupt: esc arms, a SECOND esc confirms. Armed per session,
  // auto-disarms after 3 s. The interrupt route is THE stop signal — the turn
  // stops whoever runs it (the server, another window, telegram).
  // No letter key for the confirm — the prompt's TextInput owns letters.
  const [interruptArmed, setInterruptArmed] = useState(false);
  useEffect(() => {
    if (!interruptArmed) return;
    const t = setTimeout(() => setInterruptArmed(false), 3000);
    return () => clearTimeout(t);
  }, [interruptArmed]);
  // Clear the armed state when the hold drops (the turn ended on its own).
  useEffect(() => { if (!heldNow) setInterruptArmed(false); }, [heldNow]);

  // Off while a menu owns the keyboard — see the note at the top of the file.
  useInput((ch, key) => {
    // esc while a turn runs: abort it. If something is queued, the front
    // message starts immediately (the finally block in send pops it) —
    // esc means "skip to next", not "forget what I said".
    if (key.escape && session?.busy) {
      store.abortTurn(session.id);
      return;
    }
    // esc on a remote turn: the first press arms, the second fires the
    // route and the turn stops, wherever it runs.
    if (key.escape && !session?.busy && heldNow && sessionId) {
      if (interruptArmed) {
        setInterruptArmed(false);
        void api('POST', `/sessions/${sessionId}/interrupt`).catch(quiet('interrupt'));
      } else setInterruptArmed(true);
      return;
    }
    if (key.ctrl && ch === 'o') { setExpanded((e) => !e); return; }
    if (key.ctrl && ch === 'g') { windowStore.setSidebar(!showSidebar); return; }
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
    if (key.ctrl && ch === 'n') { windowStore.openSwitcher(); return; }

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
    if (key.tab) { windowStore.cycle(key.shift ? -1 : 1); return; }
    // ↑/↓ scroll through previously sent messages. /pop handles the queue.
    if (key.upArrow && (histAt > 0 || input === '')) { recall(-1); return; }
    if (key.downArrow && histAt > 0) { recall(1); return; }
  }, { isActive: windowStore.menu === null && windowStore.view === 'chat' });

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
  // line says which mode you are in before you type, 'plan mode' or
  // 'code mode'. The » prefix is rendered by the Toolbar itself on the far
  // left. A supervisor record has no modes — you cannot chat there at all.
  const modeMark = session && !session.readonly
    ? (session.planMode ? 'plan mode on' : 'code mode on')
    : undefined;
  // Which card this session is building — the board's own name for it
  // (`PHA-7`), so the line you read while typing answers "what am I working
  // on" without opening anything. With no card attached the workspace prefix
  // alone (`PHA`) still shows: you always know which project.
  const cardMark = windowStore.cardMark;
  // The git work dot — where the session's code stands, the colored • ahead
  // of the words: red = not pushed, yellow = not merged, green = merged. The
  // same WORK map the /resume table draws from (Launcher.tsx), so the three
  // places the state shows — /resume, this line, the board — cannot disagree.
  const workMark: ToolbarPart | undefined = session?.work ? WORK[session.work] : undefined;
  // The bg task count — shown only when > 0. A zero is not news; it appearing
  // and vanishing is the signal that something started or stopped.
  const taskMark = session && windowStore.taskCount != null && windowStore.taskCount > 0
    ? `${windowStore.taskCount} bg task${windowStore.taskCount === 1 ? '' : 's'}`
    : undefined;
  // The model this session is running on — always shown so you know what you
  // are talking to. Before the first message it follows /model and /presets;
  // after, it is fixed for life.
  const modelMark = session?.summary.model;
  // The session's lifetime OUTPUT tokens (the expensive ones), right of the
  // model: the exact sum at the last seat plus whatever a running turn has
  // streamed on top. Hidden at zero — a fresh session has no news yet.
  const tokensShown = session
    ? session.totalTokens + ((session.busy || session.remoteBusy) ? tokenCount(session.tokens) : 0) : 0;
  const tokensMark = tokensShown > 0 ? formatTokensOut(tokensShown) : undefined;
  // The session's name (from /rename or the auto-title); a fresh session
  // without one yet shows nothing here. Kept current by /rename and the
  // staleness GET (window.ts), so the line moves the moment the name lands.
  const nameMark = session?.name ?? undefined;
  // Order: the mode, the card, the session's name, the git work dot (red =
  // not pushed, yellow = not merged, green = merged), the model with its
  // token meter, the bg tasks, a notice pinned last. The model and its meter
  // answer ONE question so they ride in one group — the line reads
  // `code mode on · PHA-7 · my session · • not pushed · gpt-5 12.4k ↓`,
  // facts separated by ` · `, not a flat list of fields.
  const withMode = (rest?: string): ToolbarGroup[] =>
    [[modeMark], [cardMark], [nameMark], [workMark], [modelMark, tokensMark], [taskMark], [rest]]
      .map((g) => g.filter((p): p is ToolbarPart => Boolean(p)))
      .filter((g) => g.length);

  return (
    <SizeContext.Provider value={{ rows: screenRows, cols: screenCols }}>
    <Box flexDirection="row" width={repaint ? 0 : screenCols} height={repaint ? 0 : screenRows} overflow="hidden">
    <Box flexDirection="column" width={mainCols} height={screenRows} overflow="hidden">
      {windowStore.view !== 'chat' && session ? (
        <Boundary name="board" resetKey={windowStore.view} onError={(m) => { windowStore.note(`${m} — the board closed; the stack is in ~/.phantom-cli/cli.log`); windowStore.setView('chat'); }}>
        <Board store={windowStore.boardFor(session.workspaceId)} width={mainCols} height={screenRows}
          isActive
          // One card-editor state, in the window, which also knows where esc
          // leaves it — from the board back to the columns, from anywhere else
          // back to the chat.
          card={typeof windowStore.view === 'object' ? windowStore.view.card : undefined}
          onOpenCard={(seq) => windowStore.openCard(seq, 'board')}
          onCloseCard={() => windowStore.closeCard()}
          onClose={() => windowStore.setView('chat')}
          // The card editor's Session row: back to chat, then the one open
          // path — already loaded switches, otherwise it opens (read-only
          // while the looper holds it, like /resume).
          onOpenSession={(id) => { windowStore.setView('chat'); void windowStore.openSession({ kind: 'open', id }); }}
          onArchived={() => { windowStore.setView('chat'); void windowStore.openArchived(session.workspaceId); }} />
        </Boundary>
      ) : (<>
      {/* keyFor: a part's own id, so the height the pane measured for it
          survives the list being rebuilt (a refresh reseats the whole
          conversation) and switching between sessions. */}
      <Boundary name="conversation" resetKey={session?.id} onError={(m) => windowStore.note(`${m} — the conversation stopped drawing; /resume it to redraw; the stack is in ~/.phantom-cli/cli.log`)}>
      {/* While a new session is being built (window.opening) the pane is
          cleared and the splash alone is drawn, so the ghost gets the whole
          pane instead of the space left under the old conversation. */}
      <Pane items={windowStore.opening ? [] : session ? session.done : windowStore.notes} offset={scroll} width={mainCols} onMeasure={setScrollMax} topGap
        keyFor={(p) => p.id}
        render={(p) => <PartView key={p.id} part={p} width={width} expanded={expanded} />}
        // The splash rides the pane's empty space so the header stays put:
        // clearing it blanks only the banner's own rows — the pane-swap
        // version replaced 21 rows of the screen in one frame (traced).
        fill={windowStore.splash ? <Banner width={mainCols} /> : undefined} />
      </Boundary>
      <Box ref={bottomRef} flexDirection="column" flexShrink={0}>
        {/* Session output: live parts, the working line and the queue all
            belong to the active session. During `opening` there is no
            session output to show, and while a menu is open the region is
            suspended so its changing height cannot move the menu (the
            /resume flicker — see the header). One guard for the whole
            region, so a new element added here is inside it by default. */}
        {!windowStore.opening && windowStore.menu === null && (<>
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
          escHint={session.busy
            ? (session.queue.length ? '[esc] skip to next' : '[esc] to interrupt')
            : interruptArmed ? '[esc] again to interrupt' : '[esc] to interrupt'} />}
        {session && session.queue.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text dimColor>{`  queued — esc sends next · /pop edits last`}</Text>
            <Text>{' '}</Text>
            {session.queue.map((q, i) => (
              <Text key={i}><Text color="cyan">{`  ›`}</Text>{` ${q}`}</Text>
            ))}
          </Box>
        )}
        </>)}

        <Boundary name={windowStore.menu ?? 'prompt'} resetKey={windowStore.menu} onError={(m) => { windowStore.note(`${m} — ${windowStore.menu ? `/${windowStore.menu} closed` : 'the prompt stopped drawing'}; the stack is in ~/.phantom-cli/cli.log`); windowStore.setMenu(null); }}>
        {windowStore.menu === 'sessions' ? (
          <SessionSwitcher
            sessions={store.list()} activeId={sessionId ?? ''} workspaces={windowStore.workspaceRows}
            onPick={(id) => { windowStore.setMenu(null); windowStore.switchTo(id); }}
            onCancel={() => windowStore.setMenu(null)}
          />
        ) : windowStore.menu === 'settings' ? (
          // The server's own settings; the screen's sub line says the scope.
          <Settings api={api} configPath={configPath} startAt="api"
            onClose={() => windowStore.setMenu(null)} />
        ) : windowStore.menu === 'keys' ? (
          // Its own screen so there is ONE place any credential is set — not
          // because these are a different kind of thing any more. A saved key
          // has to reach the app like any other setting change: the Assistant
          // takes its Deepgram key at spawn, and the agents take theirs at
          // build.
          <Keys api={api} onClose={() => windowStore.setMenu(null)}
            onChanged={(name) => windowStore.settingChanged(name as ConfigKey)} />
        ) : windowStore.menu === 'secrets' ? (
          // The agent's secrets, not phantom's own credentials (/keys). The
          // screen reads every layer itself — no session context needed.
          <Secrets api={api} onClose={() => windowStore.setMenu(null)} />
        ) : windowStore.menu === 'workspaceSettings' && windowStore.editing ? (
          <WorkspaceSettings
            api={api} workspace={windowStore.editing}
            // Back to the list it was opened from, refreshed — a rename there
            // has to show up here.
            onClose={() => { void windowStore.closeWorkspaceSettings(); }}
            onChanged={() => { void windowStore.refreshPicker().catch(quiet('refresh the session list')); }}
          />
        ) : windowStore.menu === 'voice' ? (
          // The Assistant's settings — local, offline. Device rows offer
          // what the sidecar found; saving a boot-time key restarts it.
          <Settings api={api} configPath={configPath} startAt="local"
            title="voice" groups={['voice']}
            suggestions={{ voice_mic_device: vs.devices.mics, voice_speaker_device: vs.devices.speakers }}
            onOpenRow={(k) => { if (k === 'voice_mic_device' || k === 'voice_speaker_device') void voice.refreshDevices(); }}
            onLocalChange={windowStore.settingChanged} onClose={() => windowStore.setMenu(null)} />
        ) : windowStore.menu === 'model' || windowStore.menu === 'server' ? (
          // /server is the ONE screen that must work with the server down — it
          // is where you fix the address — so it gets the offline api and its
          // two keys are the two that live in the file. /model writes to the
          // server like every other setting screen.
          <Settings api={windowStore.menu === 'server' ? offline : api} configPath={configPath} startAt="local"
            title={windowStore.menu} groups={[windowStore.menu === 'model' ? 'model' : 'server']}
            onLocalChange={windowStore.settingChanged} onClose={() => windowStore.setMenu(null)} />
        ) : windowStore.menu === 'presets' ? (
          <Presets api={api}
            // Applying closes the screen — the confirmation and the rebuilt
            // agents both land in the CLI the user is back at.
            onApplied={(name) => {
              windowStore.note(`preset applied: ${name}`);
              windowStore.settingChanged('provider' as ConfigKey);
            }}
            onClose={() => windowStore.setMenu(null)} />
        ) : windowStore.menu === 'duplicateModel' && windowStore.duplicating ? (
          <DuplicateModel
            presets={windowStore.duplicating.presets}
            current={windowStore.duplicating.current}
            onPick={(presetId) => { void windowStore.finishDuplicate(presetId); }}
            onCancel={() => windowStore.cancelDuplicate()} />
        ) : windowStore.menu === 'addWorkspace' ? (
          <NewWorkspace
            api={api}
            error={windowStore.addError}
            onCancel={() => windowStore.setMenu(null)}
            onSubmit={(req: NewWorkspaceRequest) => { void windowStore.addWorkspace(req); }}
          />
        ) : windowStore.menu === 'archived' && session ? (
          <Archived cards={windowStore.archived} notice={windowStore.archivedNotice}
            onNearEnd={() => { void windowStore.moreArchived(session.workspaceId); }}
            total={windowStore.archivedTotal}
            // The solo editor renders from the store, which never holds
            // archived cards on its own — seat this one first.
            onOpen={(t) => windowStore.openArchivedCard(session.workspaceId, t)}
            onRestore={(t) => { void windowStore.restoreCard(session.workspaceId, t); }}
            onCancel={() => windowStore.setMenu(null)} />
        ) : windowStore.menu === 'tasks' && windowStore.tasks ? (
          <Tasks view={windowStore.tasks} notice={windowStore.tasksNotice}
            onKill={(sid, cmd) => { void windowStore.killTask(sid, cmd); }}
            onCancel={() => windowStore.setMenu(null)} />
        ) : (windowStore.menu === 'workspace' || windowStore.menu === 'resume') && windowStore.picker ? (
            <Launcher
              mode={windowStore.menu === 'resume' ? 'sessions' : 'workspaces'}
              workspaces={windowStore.picker.workspaces} sessions={windowStore.picker.sessions} total={windowStore.picker.total}
              showSupervised={windowStore.showSupervised}
              onToggleSupervised={() => windowStore.toggleSupervised()}
              lastMessage={lastUserMessage}
              busy={(id) => store.get(id)?.busy ?? false}
              loaded={(id) => store.has(id)}
              clientId={clientId}
              notice={windowStore.pickerNotice}
              onNearEnd={windowStore.menu === 'resume' ? () => { void windowStore.morePicker(); } : undefined}
              onEdit={(id) => windowStore.editWorkspace(id)}
              onDuplicate={(id) => { void windowStore.startDuplicate(id); }}
              onStar={(id) => { void windowStore.starFromPicker(id); }}
              onClose={windowStore.closeFromPicker}
              onTrash={(id) => { void windowStore.trashSession(id); }}
              onCancel={() => windowStore.setMenu(null)}
              onPick={(l) => {
                if (l.kind === 'add') { windowStore.startAddWorkspace(); return; }
                windowStore.setMenu(null);
                void windowStore.openSession(l.kind === 'new'
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
            <Prompt value={input} onChange={(v) => { setInput(v); setSuggestAt(0); windowStore.dismissClosed(); }}
              onSubmit={(text) => { void windowStore.submit(text, suggestAt, () => { clearInput(); setScroll(0); }); }} onMeasure={setPromptTop}
              pastes={windowStore.pastes} />
            {windowStore.justClosed ? (
              // The close banner takes the toolbar's held row — the row is
              // always there, so nothing on screen moves. White on red until
              // the next action (type, submit, switch) dismisses it.
              <Box paddingLeft={2}><Text backgroundColor="red" color="white" bold>{` ${windowStore.justClosed} `}</Text></Box>
            ) : (
            <Toolbar
              // Held elsewhere: the marks, then WHO is working, the spinner,
              // and WHAT they are doing — `coding agent ⠹ building`. No
              // sentence about being locked out: the spinner says something
              // is running, and typing says the rest.
              // During `opening` the toolbar has nothing to say — the old
              // session's marks must not leak onto the splash screen.
              spin={!windowStore.opening && session && !session.busy && heldNow ? heldNow.label : undefined}
              spinWho={!windowStore.opening && session && !session.busy && heldNow ? heldNow.who : undefined}
              spinSince={!windowStore.opening && session && !session.busy && heldNow ? session.startedAt : undefined}
              groups={
              windowStore.opening ? []
              : ctrlC ? withMode('press ctrl+c again to quit')
              : !session
                ? [['no session open — [/workspace] starts one · [/resume] reopens an earlier one']]
                : withMode()} />
            )}
          </>
        )}
        </Boundary>
      </Box>
      </>)}
    </Box>
    {showSidebar && <Divider rows={screenRows} junctions={junctions} />}
    {showSidebar && <Boundary name="voice pane" resetKey={showSidebar} onError={(m) => windowStore.note(`${m} — the voice pane stopped drawing; /voice off and on redraws it; the stack is in ~/.phantom-cli/cli.log`)}>
      <VoicePanel width={sideCols - 1} voice={vs} expanded={expanded}
      offset={voiceScroll} onMeasure={setVoiceScrollMax} onDevice={windowStore.toggleDevice}
      approval={windowStore.approval} onApproval={(ok) => windowStore.approval?.resolve(ok)} />
    </Boundary>}
    </Box>
    </SizeContext.Provider>
  );
}
