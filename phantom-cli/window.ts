// The window: every session open in this terminal, the boards behind them,
// and what is on screen. Outside React, like SessionStore and BoardStore and
// for the same reason — a turn keeps streaming in a session you are not
// looking at, and the Assistant can open, close and switch sessions while no
// render is happening. App.tsx is a view over this object.
//
// The rule that shapes it: anything with a caller that is not a React event
// lives here. Typing, scrolling and the two toggles that only a keypress
// moves stay in App.
import type { ReactNode } from 'react';
import { hostname } from 'node:os';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Tool } from 'ai';
import { SessionStore, activeHold, type LoadedSession, type ModelLine } from './sessions.js';
import type { AgentHandlers, BackendClient, ToolKit } from 'phantom-client-sdk';
import { parseLines, conversationFrom, usageTotals } from 'phantom-client-sdk/transcript';
import { CodingAgent } from '../core/agents/coding.js';
import { AssistantAgent } from '../core/agents/assistant.js';
import { SessionFeed } from './sessionFeed.js';
import { SettingsFeed } from './settingsFeed.js';
import { SessionsFeed } from './sessionsFeed.js';
import { BoardStore, type Card, type Stream } from './board.js';
import { VoiceClient, sidecarEnv, codingKanbanTool, screenModeTools,
  type KanbanArgs, type ScreenModeHandler } from './voice.js';

import { messagesToParts, nextId, type Part } from './state.js';
import { kanbanOps } from './kanban.js';
import { PasteStore } from './paste.js';
import { quiet, watchConnection, type Api } from './request.js';
import { VOICE_BOOT_KEYS, isLocalKey, type ConfigValue } from './config.js';
import { makeSettings } from './settings.js';
import { label, lastProjectId, type SessionInfo, type ProjectInfo } from './components/Launcher.js';
import type { TasksView } from './components/Tasks.js';
import type { NewProjectRequest } from './components/NewProject.js';
import { COMMANDS, fillOf, matches, parse, type Choices } from './commands.js';
import { ProjectDirectory, assistantToolKit } from './assistantKit.js';
import { confirmDialog, boardScreen, switcherScreen, settingsScreen, keysScreen, secretsScreen,
  serverScreen, presetsScreen, projectSettingsScreen,
  addProjectScreen, archivedScreen, tasksScreen, pickerScreen } from './screens.js';

/** What the window remembers about a project: the banner's display name and
 *  the prefix its cards are named with (`PHA` → `PHA-7`). `error` says why a
 *  lookup fell back to the id, so a bare id never passes for a name. */
export interface WsFacts { label: string; cardPrefix?: string; error?: string }

/** What opening resolves to. core's openSession turns each into the same
 *  create / restart / attach path. */
export type OpenTarget = { kind: 'new'; projectId: string } | { kind: 'open'; id: string }
  | { kind: 'duplicate'; id: string };

/** An ask standing in the Assistant's pane, and the promise its tool is
 *  parked on. */
export interface Approval { label: string; subject: string; resolve: (ok: boolean) => void }

/** Closing answers with facts; each door renders them where its user is
 *  looking (the pane for /close, the picker's notice line for [x]). */
export type CloseResult = { ok: true; closed: string; on_screen: string; opened_new: boolean }
  | { error: string };

// ── Overlay ───────────────────────────────────────────────────────────────
// One field, one concept: a screen is showing on top of the chat, or not.
// A FULL overlay replaces the whole column (every menu, the board); a THIRD
// takes the bottom third with the conversation still above it (the glance
// lists: /tasks). The component inside owns its
// drawing and its keyboard; the window just puts it on screen and delivers
// the result when it goes. Every overlay is built in screens.tsx.
//
// A DIALOG is the one thing that sits on top of an overlay: a yes/no in its
// own slot at the bottom of the column, whatever is under it. While one is
// up the component beneath stops taking keys (components/useInput.ts).

export interface Overlay {
  size: 'full' | 'third';
  /** What is up, for the log line and the few gates that ask (`boardUp`). */
  name: string;
  /** Draws it. Runs on every App render, so it reads the store's CURRENT
   *  data each time. `main` is the column's size — the board lays out by it. */
  render: (main: { width: number; height: number }) => ReactNode;
  /** Fires when the overlay goes. `undefined` when something else took it
   *  off the screen. Fires AFTER the field is cleared, so it may safely show
   *  another overlay. */
  onDismiss?: (result: unknown) => void;
  /** Re-read while up, every `pollMs` — a list whose rows the server cannot
   *  announce (/tasks reads a container). Stopped on dismiss. */
  poll?: () => void;
  /** Follow a server feed while up: starts the subscription, returns its
   *  stop. The live way — /resume rides the session list feed. */
  watch?: () => () => void;
}

export interface Dialog {
  render: () => ReactNode;
  /** Rows it draws, so the screen under it can give them up. */
  rows: number;
  /** The answer: enter's true, esc's false, `undefined` when taken down. */
  onDismiss: (result: unknown) => void;
}

/** /resume's page size: what the picker fetches at open and appends per
 *  scroll-to-the-bottom. Comfortably more than a screenful, small enough that
 *  a list of thousands never rides one response. */
export const PICKER_PAGE = 30;
/** How long after the last keystroke in /resume's filter line the list re-reads. */
const PICKER_FILTER_DEBOUNCE_MS = 150;

export interface WindowOptions {
  api: Api;
  /** The window's connection, for the agents: every open session runs its
   *  turns through it, under this window's identity. */
  backend: () => BackendClient;
  /** GET a server ND-JSON stream as records — each BoardStore follows its
   *  project's `/events` through it. Absent (tests): boards load once. */
  stream?: Stream;
  configPath?: string;
  /** What launching wants: resume a named session, or find a project and
   *  start. The splash waits on the outcome — see `splash`. */
  boot?: { resumeId?: string };
  makeVoice?: () => VoiceClient;
  /** POST /git/auto-push for one session, consuming its ND-JSON stream:
   *  `onStep` gets a human label per step, the promise resolves with the final
   *  result. Absent in tests, and /auto-push then says so. */
  autoPush?: (sessionId: string, onStep?: (label: string) => void) =>
    Promise<{ result: string; reason?: string; sha?: string }>;
  /** POST /git/auto-pull, the same shape — base INTO the session's branch. */
  autoPull?: (sessionId: string, onStep?: (label: string) => void) =>
    Promise<{ result: string; reason?: string; arrived?: string[]; files?: string[]; sha?: string; pushed?: boolean }>;
  /** Fired whenever the session on screen changes. */
  onSession?: (s: { id: string; branch: string; projectId: string }) => void;
  /** Ink's exit, so /exit and ctrl+c can end the process. */
  exit?: () => void;
  /** Width of the voice pane as a percent, when `sidebar_width` is not set. */
  sidebarPercent?: number;
  /** This window's session-lock id, so its own held sessions do not read
   *  "in use" on /resume. Empty in tests. */
  clientId?: string;
  /** How often the open /tasks list refreshes (the container is read, not
   *  announced). /resume and session state follow live feeds. Test seam. */
  pollMs?: number;
  /** How often the session's container is asked what is running while the
   *  window idles. Turn ends and opening /tasks refresh it too. Test seam. */
  taskPollMs?: number;
}



/** Each voice switch IS a setting: the toggle writes it, and the state holds
 *  across engine and TUI restarts. */
const SWITCH_KEY: Record<'mic' | 'speaker' | 'headphones' | 'wake', string> = {
  mic: 'voice_mic_muted', speaker: 'voice_speaker_muted',
  headphones: 'voice_headphones', wake: 'voice_wake_word',
};

/** The banner at the top of a session: where you are, then the model line. */
function bannerParts(s: { project: string; branch: string },
  summary: { provider: string; model: string; reasoning: string }): Part[] {
  return [
    `${s.project} · ${s.branch}`,
    `${summary.provider}/${summary.model} · reasoning ${summary.reasoning}`,
  ].map((text) => ({ kind: 'note', id: nextId('note'), text }) as Part);
}

export class WindowStore {
  /** Every session open here, and the one turn each may run. */
  readonly sessions: SessionStore;
  /** The Assistant, over the Python sidecar. Constructed, never started: the
   *  window comes up with voice off unless a setting says otherwise. */
  readonly voice: VoiceClient;
  /** One board per project, shared by the /kanban view, the Assistant's
   *  board tool and every coding session's — so a tool edit repaints an open
   *  board with no extra wiring. */
  private readonly boards = new Map<string, BoardStore>();
  /** Display name and card prefix per project: a display cache, cleared
   *  when the settings feed says they may have changed. */
  private readonly projectNames = new Map<string, WsFacts>();

  /** The launch splash, where the conversation will be. Off until a session
   *  with nothing said yet is actually opening (openSession raises it): the
   *  window opens blank, and boot decides — a picker or a form comes up with
   *  no ghost under it; a session opening puts the ghost up once. The
   *  alternative (guessing at construction) flashed the ghost, covered it
   *  with the picker, then drew it again after the pick. Cleared by the
   *  first thing that wants the screen back. */
  splash: boolean;
  /** A new session is being built for this window. The pane draws NOTHING
   *  but the splash until it lands — the old conversation would otherwise
   *  stay on screen for the network calls, squeezing the ghost into the
   *  rows under it and then jumping to full size when the new session
   *  arrives (2026-09-07). */
  opening = false;
  /** Notes with no session to land in — a failed boot open, a refused
   *  command. Rendered where the conversation would be. */
  notes: Part[] = [];

  /** A timed message on the status bar — white text on a colored background,
   *  auto-cleared after 1.75s. Used for things that need to be seen without
   *  polluting the pane. The background says the kind: red = something was
   *  removed ("Session closed"), cyan = just information ("only session"). */
  toast: { text: string; bg: string } | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  setToast(text: string, bg: 'red' | 'cyan' = 'red', ms = 1750): void {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toast = { text, bg };
    this.toastTimer = setTimeout(() => { this.toast = null; this.toastTimer = null; this.notify(); }, ms);
    this.notify();
  }

  /** The version a background auto-update put in place this run (autoUpdate.ts),
   *  or null. While set, the prompt's version label swaps to name it — the
   *  running process is still the old build; next launch runs this one. */
  updateReady: string | null = null;
  setUpdateReady(v: string): void { this.updateReady = v; this.notify(); }

  /** The window's paste chips: the prompt holds `[Pasted #1 ~12 lines]`,
   *  this holds the text, and submit swaps it back before anything downstream
   *  can see the chip (paste.ts). */
  readonly pastes = new PasteStore();

  /** The unsent text on the prompt, asked for at the moment of a switch so it
   *  can be parked on the session being left. App fills this in. */
  draftOnScreen: () => string = () => '';

  /** Inject text into the prompt — /pop puts the popped message here for
   *  editing. App wires this up the same way it wires draftOnScreen. */
  setPrompt: (text: string) => void = () => {};

  /** The voice pane's override: null follows the voice_enabled setting, true
   *  and false are ctrl+g. */
  sidebar: boolean | null = null;

  /** The Assistant's gated tool waits here until the user answers. It is the
   *  ASSISTANT asking, so the ask lives in ITS pane. Answered by clicking
   *  accept or decline, or by SAYING the exact word. ONE at a time; the tool
   *  call's abort declines, so a dead turn cannot leave the ask up waiting for
   *  an answer nothing would receive. A plain field, not React state: the next
   *  tool call can land before a render, and this must already be right. */
  approval: Approval | null = null;

  // ── the overlay ───────────────────────────────────────────────────────────────────
  // What is on top of the chat. ONE field for the board, a card's editor,
  // every menu and every confirmation: a gate that used to read "no menu
  // open AND the chat view" reads this alone. The menus used to squeeze in
  // under the conversation, each at its own height — that split is gone;
  // anything full takes the whole column, as the board always did.

  /** The overlay up now, or null: the chat, its prompt and its keys. */
  overlay: Overlay | null = null;
  /** The question up now, over whatever is under it, or null. */
  dialog: Dialog | null = null;

  /** Put an overlay on screen. One at a time: whatever was up goes first,
   *  unanswered (its callback gets `undefined`). A screen retires the
   *  splash, and one that polls starts its clock — a failed tick is silent,
   *  because an unreachable server must not nag every few seconds while
   *  old rows serve. */
  showOverlay(o: Overlay): void {
    if (this.overlay) this.dismissOverlay(undefined);
    this.overlay = o;
    this.splash = false;
    if (o.poll) {
      this.overlayClock = setInterval(o.poll, this.pollMs);
      this.overlayClock.unref?.();
    }
    if (o.watch) this.overlayWatch = o.watch();
    this.notify();
  }

  /** Take the overlay down and deliver its answer — every screen's esc and
   *  close, every confirm's enter. The field is cleared BEFORE the callback
   *  fires, so the callback may open another overlay without being clobbered. */
  dismissOverlay = (result?: unknown): void => {
    const prev = this.overlay;
    this.overlay = null;
    if (this.overlayClock) { clearInterval(this.overlayClock); this.overlayClock = null; }
    if (this.overlayWatch) { this.overlayWatch(); this.overlayWatch = null; }
    // A question about what just left the screen has no answer.
    if (this.dialog) this.dismissDialog(undefined);
    prev?.onDismiss?.(result);
    this.notify();
  };

  /** Put a question up. One at a time: a second one replaces the first,
   *  unanswered. */
  showDialog(d: Dialog): void {
    if (this.dialog) this.dismissDialog(undefined);
    this.dialog = d;
    this.splash = false;
    this.notify();
  }

  /** Take the question down with its answer — the dialog's enter and esc,
   *  ctrl+c, and whatever replaces what it was asking about. */
  dismissDialog = (result?: unknown): void => {
    const prev = this.dialog;
    this.dialog = null;
    prev?.onDismiss(result);
    this.notify();
  };

  /** The question on screen right now: the window's own (a safety check you
   *  just triggered) first, else the on-screen session's parked agent
   *  question — but ONLY in the session's chat view, never on a full overlay
   *  (/resume, board, settings). Another session's question is NOT here — it
   *  waits on its session (LoadedSession.ask). THE one read for the view and
   *  the gates. */
  get dialogOnScreen(): Dialog | null {
    if (this.dialog) return this.dialog;
    if (this.overlay?.size === 'full') return null;
    return this.sessions.active()?.ask ?? null;
  }

  /** True while anything is up — the one gate for input routing: the chat's
   *  handlers and the prompt are off while this is true. */
  get hasOverlay(): boolean { return this.overlay !== null || this.dialogOnScreen !== null; }

  /** The board owns the column (a card opened from it counts). The
   *  Assistant's "show card" asks, to know where esc should go back to. */
  get boardUp(): boolean { return this.overlay?.name === 'board'; }

  /** THE yes/no, wherever you are — the chat, /resume, the board: enter is
   *  yes, esc is no, and so is anything that takes the question off the
   *  screen. An AGENT's question names the asker (`who`) and rides its
   *  turn's abort: a stopped turn takes the question down, answered no, so
   *  nothing waits on a dead call. A question ABOUT a session (`session`)
   *  lives on that session, not the window: it shows only while that
   *  session is on screen, so a turn running in the background cannot pop
   *  its question over the session you are reading — and enter cannot
   *  approve something on a session you are not looking at. */
  confirm(title: string, message?: string, ask?: { who: string; signal?: AbortSignal; session?: string }): Promise<boolean> {
    return new Promise((resolve) => {
      if (ask?.signal?.aborted) { resolve(false); return; }
      const session = ask?.session;
      const dismiss = session ? (r?: unknown) => this.sessions.answerAsk(session, r) : this.dismissDialog;
      const standing = () => (session ? this.sessions.get(session)?.ask : this.dialog) === dialog;
      const dialog = confirmDialog(dismiss, title, message, ask?.who, (yes) => {
        ask?.signal?.removeEventListener('abort', onAbort);
        resolve(yes);
      });
      const onAbort = () => { if (standing()) dismiss(false); };
      ask?.signal?.addEventListener('abort', onAbort);
      if (session) {
        this.sessions.setAsk(session, dialog);
        // Asked from a session you are not on: say so where you are, once;
        // the session list (ctrl+n) keeps saying it until you answer.
        if (this.sessions.activeId !== session) {
          const e = this.sessions.get(session);
          this.setToast(`${e?.name ?? e?.branch ?? 'a session'} needs approval — tab or /resume`, 'cyan');
        }
      } else {
        this.showDialog(dialog);
      }
    });
  }

  /** /kanban, and the Assistant's "show the board". */
  openBoard(): void {
    const e = this.sessions.active();
    if (!e) { this.note('no session is open — the board belongs to a project; /project starts a session in one'); return; }
    this.showOverlay(boardScreen(this, e.projectId));
  }

  /** A card's editor, and where esc leaves it: opened from the board it goes
   *  back to the columns; from anywhere else, to the chat. */
  openCard(number: number, back: 'chat' | 'board' = 'chat'): void {
    const e = this.sessions.active();
    if (!e) return;
    this.showOverlay(boardScreen(this, e.projectId, { number, back }));
  }

  /** The open list's re-read clock (`Overlay.poll`), unref'd so it never
   *  holds the process open. */
  private overlayClock: ReturnType<typeof setInterval> | null = null;
  /** The open overlay's feed subscription (`Overlay.watch`), stopped with it. */
  private overlayWatch: (() => void) | null = null;
  private get pollMs(): number { return this.opts.pollMs ?? 3_000; }

  /** ctrl+g, and the nudge that puts the pane back when the Assistant needs to
   *  be seen. `undefined` clears the override back to the setting. */
  setSidebar(on: boolean | null): void { this.sidebar = on; this.notify(); }

  /** Put the ask on screen and wait for the answer. */
  requestApproval = (ask: { label: string; subject: string }, signal?: AbortSignal): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (signal?.aborted) { resolve(false); return; }
      const done = (ok: boolean) => {
        signal?.removeEventListener('abort', onAbort);
        this.approval = null;
        this.notify();
        resolve(ok);
      };
      const onAbort = () => done(false);
      signal?.addEventListener('abort', onAbort);
      this.approval = { ...ask, resolve: done };
      // The ask is in the voice pane, so make sure the pane is on screen — an
      // explicit ctrl+g hide is respected no more.
      if (this.sidebar === false) this.sidebar = null;
      this.notify();
    });

  /** The spoken answer. Anything that is not the exact word is swallowed while
   *  an ask stands (exact match like the wake word, never interpretation). */
  answerBySpeech = (text: string): boolean => {
    const a = this.approval;
    if (!a) return false;
    const word = text.toLowerCase().replace(/[^a-z]/g, '');
    if (word === 'accept') a.resolve(true);
    else if (word === 'decline') a.resolve(false);
    return true;
  };

  private readonly listeners = new Set<() => void>();
  private readonly settings;
  private readonly settingsFeed: SettingsFeed | null;
  /** Every request this window makes, riding the connection watch — the
   *  screens share it so a save that reaches the server after an outage
   *  triggers the same recovery a chat request would. */
  readonly api: Api;
  /** Bumped when another client wrote settings; menus keyed on it re-read. */
  settingsVersion = 0;
  /** The two launch facts the screens need: /settings and /server edit the
   *  local file at this path; /resume marks this window's own holds. */
  get configPath(): string | undefined { return this.opts.configPath; }
  get clientId(): string { return this.opts.clientId ?? ''; }

  constructor(private readonly opts: WindowOptions) {
    // Every request rides the connection watch: the first success after an
    // outage fires recover(), which puts everything this window holds right
    // from the record — the request path's version of a feed's reconnect.
    this.api = watchConnection(opts.api, () => this.recover());
    this.settings = makeSettings(this.api, opts.configPath);
    this.settingsFeed = opts.stream
      ? new SettingsFeed(opts.stream, () => this.settingsWrittenElsewhere(), opts.clientId)
      : null;
    this.settingsFeed?.start();
    this.projects = new ProjectDirectory(this.api);
    this.voice = (opts.makeVoice ?? (() => new VoiceClient()))();
    this.splash = false;
    // Defaults only until readChrome's first server read lands.
    this.voiceEnabled = false;
    this.sidebarWidth = opts.sidebarPercent ?? 20;
    this.sessions = this.newSessionStore();
    // One subscription for the view: the window forwards what its parts say.
    this.sessions.subscribe(() => this.notify());
    this.voice.subscribe(() => this.notify());
    // The task count follows whichever session is on screen, and every turn
    // that settles (a turn is when tasks start and stop).
    this.onTurnEnded = () => this.refreshTasks();
    this.watchTasks();
    // Spoken words reach the approval before they reach the brain: while an
    // ask stands, `intercept` claims everything said (and answers with false
    // when none does, so an ordinary turn passes straight through).
    this.voice.intercept = this.answerBySpeech;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void { for (const l of [...this.listeners]) l(); }

  /** Settings, read where they are used. Never held: the settings object asks
   *  its store on every call, and the result lives only for this operation. */
  private readSettings = async (): Promise<Record<string, ConfigValue>> =>
    this.settings.read();

  // ── boards ────────────────────────────────────────────────────────────────

  boardFor(projectId: string): BoardStore {
    let b = this.boards.get(projectId);
    if (!b) {
      b = new BoardStore(this.api, projectId, this.opts.stream);
      b.follow();
      this.boards.set(projectId, b);
    }
    return b;
  }

  /** The coding agent's board handler, bound to the session's OWN project —
   *  not the one on screen: a turn keeps running while you switch away. */
  private codingKanbanHandler = (projectId: string) =>
    (args: KanbanArgs) => kanbanOps(this.boardFor(projectId), args);

  // ── plan mode, for both in-window agents ──────────────────────────────────

  /** getMode reads the SESSIONS TABLE, not this window's mirror: a session
   *  open in the background could answer from a copy a server-run agent or another
   *  window has since changed. Having read the row it FOLLOWS it, so the
   *  answer and this window's kit converge. enterPlan is the agents' one-way
   *  on-switch; the user's /code or the Assistant's enterCode comes back.
   *  Bound to a session id for the coding agent; unbound = the session on
   *  screen, for the Assistant. */
  screenOps(sessionId?: string): ScreenModeHandler {
    const at = () => (sessionId ? this.sessions.get(sessionId) : this.sessions.active());
    return {
      getMode: async () => {
        const e = at();
        if (!e) return { error: 'no session is open' };
        try {
          const r = await this.api('GET', `/sessions/${e.id}`) as { planMode?: boolean };
          if (typeof r?.planMode !== 'boolean') throw new Error('the row carried no plan_mode');
          await this.applyPlanMode(e.id, r.planMode);
          return { mode: r.planMode ? 'plan' : 'code' };
        } catch (err) {
          // The record is out of reach: answer with what this window holds and
          // SAY so — a mode the agent cannot check is worse than a noted one.
          return { mode: e.planMode ? 'plan' : 'code',
            note: `could not read the session row (${(err as Error).message}) — this is what this window holds` };
        }
      },
      enterPlan: async () => {
        const e = at();
        if (!e) return { ok: false, error: 'no session is open' };
        if (e.planMode) return { ok: false, error: 'already in plan mode' };
        await this.api('PATCH', `/sessions/${e.id}`, { plan_mode: true });
        await this.applyPlanMode(e.id, true);
        return { ok: true };
      },
      // Direct code mode: the Assistant switches without approval.
      enterCode: async () => {
        const e = at();
        if (!e) return { ok: false, error: 'no session is open' };
        if (!e.planMode) return { ok: false, error: 'already in code mode' };
        await this.api('PATCH', `/sessions/${e.id}`, { plan_mode: false });
        await this.applyPlanMode(e.id, false);
        return { ok: true, mode: 'code', note: 'code mode is now active' };
      },
      // The one way the CODING agent LEAVES plan mode: through the user. The
      // ask is parked on the SESSION it is about (LoadedSession.ask), named
      // as the agent's with the branch, tied to the turn's abort — so a
      // background session's question waits for you to come to it, and the
      // answer flips the session that asked, never the one on screen at the
      // time. The flip is the same record-first write /code makes; a turn
      // already streaming keeps the kit it started with, so code mode is
      // real from the next turn — the answer says so.
      askCodeMode: async (reason, { abortSignal }) => {
        const e = at();
        if (!e) return { ok: false, error: 'no session is open' };
        if (!e.planMode) return { ok: false, error: 'already in code mode' };
        // Bound to a session = the coding agent; unbound = the Assistant.
        const yes = await this.confirm('enter code mode?', reason,
          { who: `${sessionId ? 'coding agent' : 'the Assistant'} · ${e.name ?? e.card ?? e.branch}`, signal: abortSignal, session: e.id });
        if (!yes) return { ok: false, declined: true, mode: 'plan' };
        await this.api('PATCH', `/sessions/${e.id}`, { plan_mode: false });
        await this.applyPlanMode(e.id, false);
        return { ok: true, mode: 'code', note: 'code mode is now active' };
      },
    };
  }

  /** Flip a loaded session's plan mode flag. The toolkit is always the full
   *  set — the planMode callback each tool closes over reads this flag, so
   *  flipping it is all that is needed for the gate to change. No kit rebuild,
   *  no agent rebuild. /plan calls this after its PATCH lands; the feed calls
   *  it when the server says another window flipped it. A turn already
   *  streaming sees the flip immediately through the callback. No-op while
   *  nothing changed; a supervisor record never flips. */
  applyPlanMode = async (id: string, on: boolean): Promise<void> => {
    const e = this.sessions.get(id);
    if (!e || e.planMode === on) return;
    this.sessions.setPlanMode(id, on);
  };

  /** The tools only this window can serve for a coding session: the board
   *  from here, the screen's modes and the code-mode ask. The server's tools
   *  come with every turn start; these ride beside them. `mutating` names
   *  the ones plan mode refuses. */
  private cliToolKit(sessionId: string, projectId: string): ToolKit {
    return {
      name: 'cli',
      build: async () => {
        const tools: Record<string, Tool> = {
          ...codingKanbanTool(this.codingKanbanHandler(projectId)),
          ...screenModeTools(this.screenOps(sessionId)),
        };
        return { tools, mutating: Object.keys(tools).filter((n) => /create|update|move|block|enter_code|set_mode/.test(n)) };
      },
    };
  }

  /** The banner's model line before any turn: the row's provider/model, the
   *  project's reasoning setting. After the first turn, turn-start's word. */
  private async modelLineFor(row: { provider?: string | null; model?: string | null }, projectId: string): Promise<ModelLine> {
    let reasoning = '';
    try {
      const st = await this.api('GET', `/settings?project=${encodeURIComponent(projectId)}`) as Record<string, { value?: unknown }>;
      reasoning = String(st.coding_reasoning?.value ?? '');
    } catch (e) { quiet('read the reasoning setting')(e); }
    return { provider: row.provider || 'unset', model: row.model || 'unset', reasoning };
  }

  // ── the session store, and the turn's two ends ────────────────────────────

  private newSessionStore(): SessionStore {
    const s: SessionStore = new SessionStore(() => {
      // The toolbar's task count follows every turn — a turn is when tasks
      // start and stop. Background: a failure goes to cli.log, not the pane.
      void this.onTurnEnded?.().catch(quiet('refresh tasks'));
    });
    // A refused send puts the words back: into the box when that session is
    // on screen, into its draft otherwise — either way the next switch to it
    // shows them.
    s.onRefused = (id, text) => {
      if (id === this.sessions.activeId) this.setPrompt(text);
      else { const e = this.sessions.get(id); if (e) e.draft = text; }
    };
    return s;
  }

  /** Whatever wants to hear that a turn settled. The /tasks count hangs off
   *  it: a turn is when tasks start and stop. */
  onTurnEnded: (() => Promise<void>) | null = null;

  /** Re-read one loaded session's row and pull whatever moved: plan mode,
   *  git work state, the transcript (refreshIfMoved reseats when the stamp
   *  moved). App's streamless mount fill and the outage recovery both come
   *  through here — one place that knows what "bring this session current"
   *  means. Quiet on failure: the caller runs again on its own. */
  recheckSession = async (id: string): Promise<void> => {
    const cur = this.sessions.get(id);
    if (!cur || cur.busy) return;
    try {
      const r = await this.api('GET', `/sessions/${id}`) as {
        planMode?: boolean; transcript_updated_at?: string | null;
        work?: 'not_pushed' | 'not_merged' | 'merged' | null };
      if (typeof r.planMode === 'boolean') await this.applyPlanMode(id, r.planMode);
      this.sessions.setWork(id, r.work ?? null);
      await this.refreshIfMoved(id, r.transcript_updated_at ?? null);
    } catch (e) { quiet(`re-read session ${id}`)(e); }
  };

  /** The server is reachable again after a stretch of failures (the
   *  connection watch's first success after a failure). Everything this
   *  window holds may be stale or unsaved, so put it right from the record —
   *  the same refill a feed reconnect runs, for the request path: every open
   *  session re-read, every failed transcript upload retried, the open list
   *  refreshed. One note says it happened, so a screen that fixes itself is
   *  not a mystery. */
  private recover = async (): Promise<void> => {
    for (const e of this.sessions.list()) await this.recheckSession(e.id);
    // The open list, if one polls, re-reads now rather than on its next tick.
    this.overlay?.poll?.();
    this.note('back in touch with the server — everything re-synced');
  };

  /** Compare the server's transcript stamp with what the SCREEN matches;
   *  when it moved, read the record and repaint. The ONE repaint path:
   *  switch, and the feed's record-landed. The agent keeps its own copy
   *  current on its own, at its next turn start. `server` is the stamp the
   *  caller already holds; null means don't look. Never caught here — a
   *  failure inside the feed's handler must reject into followStream so the
   *  link reconnects onto a fresh snapshot. */
  refreshIfMoved = async (id: string, server: string | null, keepScreen = false): Promise<void> => {
    const cur = this.sessions.get(id);
    if (!cur || cur.busy || !server || server === cur.syncStamp) return;
    const t = await this.api('GET', `/sessions/${id}/transcript`) as
      { data: string | null; updated_at?: string | null };
    const lines = parseLines(t.data ?? '');
    // keepScreen: the feed showed us this whole turn as it happened, so the
    // record brings the stamp and the totals and the screen keeps what it
    // drew — richer than a replay, and no repaint to jump through.
    this.sessions.reseat(id, keepScreen ? null : [
      ...cur.done.slice(0, 2),
      { kind: 'note', id: nextId('note'), text: 'refreshed — this session moved forward elsewhere' } as Part,
      ...messagesToParts(conversationFrom(lines)),
    ], t.updated_at ?? server, usageTotals(lines));
  };

  // ── what is on screen ─────────────────────────────────────────────────────

  /** A note lands in the conversation, or in the window's own list when no
   *  session is open yet. Either way it retires the splash: a message the
   *  banner covers is a message lost. */
  note = (text: string): void => {
    this.splash = false;
    if (this.sessions.active()) this.sessions.note(this.sessions.activeId, text);
    else {
      this.notes = [...this.notes, { kind: 'note', id: nextId('note'), text } as Part];
      this.notify();
    }
  };

  setSplash(on: boolean): void { this.splash = on; this.notify(); }

  /** Files dragged onto the window (drop.ts caught the paste before it
   *  became text). Each is read locally and uploaded into the active
   *  session's scratch pad; the agent hears where it landed through the
   *  user message queue on the next turn — the drop itself sends
   *  nothing, the user is still typing.
   *
   *  Returns a combined chip string to insert at the cursor (one chip per
   *  file that uploaded successfully), or null when nothing landed. */
  dropFiles = async (paths: string[]): Promise<string | null> => {
    const session = this.sessions.active();
    if (!session) { this.note('a dropped file needs an open session — /new or /resume first'); return null; }
    const chips: string[] = [];
    for (const p of paths) {
      try {
        const data = await readFile(p);
        const r = await this.api('POST', `/sessions/${session.id}/attachments`,
          { name: basename(p), data: data.toString('base64') }) as { path?: string };
        const name = basename(p);
        const scratchPath = r.path ?? 'the scratch pad';
        chips.push(this.pastes.collapseFile(name, scratchPath));
        this.sessions.note(session.id, `${name} uploaded to the scratch pad`);
      } catch (e) {
        this.sessions.note(session.id, `drop failed: ${basename(p)} — ${(e as Error).message}`);
      }
    }
    return chips.length ? chips.join(' ') : null;
  };

  /** Show that session's conversation in the pane, tail first. The unsent
   *  text goes with the session being left and comes back with it. */
  /** Show that session's conversation in the pane, tail first. The unsent
   *  text goes with the session being left and comes back with it. */
  switchTo = (id: string): void => {
    const prev = this.sessions.active();
    if (prev) prev.draft = this.draftOnScreen();
    if (!this.sessions.activate(id)) return;
    this.splash = false;
    const e = this.sessions.get(id);
    if (e) this.opts.onSession?.({ id: e.id, branch: e.branch, projectId: e.projectId });
    this.watchTasks();
    this.notify();
    // Cheap staleness check in the background: pull only when the server's
    // stamp actually moved.
    if (e && !e.busy) {
      void (async () => {
        try {
          const row = await this.api('GET', `/sessions/${id}`) as
            { transcript_updated_at?: string | null; name?: string | null };
          // The row carries the name too — refresh the seated copy off the
          // same answer, so the header names the session right.
          if (row?.name !== undefined) this.sessions.setName(id, row.name ?? null);
          await this.refreshIfMoved(id, row?.transcript_updated_at ?? null);
        } catch (err) { quiet(`check session ${id} for changes`)(err); }
      })();
    }
  };

  /** tab and shift+tab: the next session in the ring. */
  cycle(dir: 1 | -1): void {
    const target = this.sessions.next(dir);
    if (!target) { this.setToast('this is the only session open — /new or /resume opens another', 'cyan'); return; }
    this.switchTo(target.id);
  }

  // ── projects ────────────────────────────────────────────────────────────

  /** The project LIST carries the same two facts per row: whoever reads it
   *  refreshes the display cache, so a later open needs no lookup. */
  seedWsFacts(list: { id: string; name?: string; displayName?: string | null; cardPrefix?: string }[]): void {
    for (const project of list) {
      const label = project.displayName || project.name;
      if (label) this.projectNames.set(project.id, { label, ...(project.cardPrefix ? { cardPrefix: project.cardPrefix } : {}) });
    }
  }

  /** The display name and card prefix for a project. A failure answers
   *  with the id AND says why, so an id never passes for a project called
   *  that. */
  async projectFacts(id: string): Promise<WsFacts> {
    const hit = this.projectNames.get(id);
    if (hit) return hit;
    try {
      const project = await this.api('GET', `/projects/${id}`) as
        { name?: string; displayName?: string | null; cardPrefix?: string };
      const found = project.displayName || project.name;
      if (!found) throw new Error('the server sent no name for it');
      const facts: WsFacts = { label: found, ...(project.cardPrefix ? { cardPrefix: project.cardPrefix } : {}) };
      this.projectNames.set(id, facts);
      return facts;
    } catch (e) {
      return { label: id, error: `could not read project ${id}'s name: ${(e as Error).message}` };
    }
  }

  /** The name to say for a project id — the id itself when unknown, which
   *  is still an answer rather than a blank. */
  wsLabel(id: string): string { return this.projectNames.get(id)?.label ?? id; }

  /** What the toolbar calls the work in front of you: the card the session is
   *  building, named the way the board names it (`PHA-7`), and failing that
   *  the project's prefix alone (`PHA`) so the line always says which
   *  project you are in. Nothing at all when neither is known. */
  get cardMark(): string | undefined {
    const e = this.sessions.active();
    if (!e) return undefined;
    return e.card ?? this.projectNames.get(e.projectId)?.cardPrefix;
  }

  // ── opening and closing ───────────────────────────────────────────────────

  /** Opening JOINS the window rather than replacing what is here. One already
   *  loaded is switched to, never opened twice. core's openSession is the ONE
   *  path that resolves the target (create / restart / attach), pulls the
   *  server transcript and the frozen prompt. Opening never locks. */
  openSession = async (target: OpenTarget): Promise<boolean> => {
    try {
      if (target.kind === 'open') {
        if (target.id === this.sessions.activeId) { this.note('already here'); return true; }
        if (this.sessions.has(target.id)) { this.switchTo(target.id); return true; }
        // Clear the splash now so it never flashes during the calls that
        // follow; the end of this function sets it back for an empty session.
        this.splash = false;
        this.notify();
      }
      if (target.kind === 'new') {
        // The conversation will be empty: clear the pane and put the splash
        // up NOW, so the ghost has the whole pane while the calls run.
        this.opening = true;
        this.splash = true;
        this.notify();
      }
      // The session IS its agent: resumed (an id — /resume, a duplicate's
      // copy) or made new (/new, /project). Resuming only reads; nothing
      // is held until the first turn.
      // The agent's handlers forward to the store entry by the agent's own
      // session id — known only once it exists. A failure before that is the
      // create/resume rejection, caught below.
      let made: CodingAgent | null = null;
      const forEntry = () => (made && this.sessions.has(made.session.id) ? this.sessions.handlersFor(made.session.id) : null);
      const handlers: AgentHandlers = {
        onError: (e) => forEntry()?.onError(e),
        onNotice: (n) => forEntry()?.onNotice(n),
      };
      const backend = this.opts.backend();
      const agent: CodingAgent = target.kind === 'new'
        ? await CodingAgent.newSession(backend, handlers, target.projectId)
        : await CodingAgent.resumeSession(backend, handlers, target.kind === 'duplicate'
          ? ((await this.api('POST', `/sessions/${target.id}/duplicate`) as { id: string }).id)
          : target.id);
      made = agent;
      agent.addToolKit(this.cliToolKit(agent.session.id, agent.session.projectId));
      const row = await this.api('GET', `/sessions/${agent.session.id}`) as { id: string; branch: string; projectId: string;
        name?: string | null; agent?: string | null; card?: number | null; planMode?: boolean; pinned?: boolean;
        provider?: string | null; model?: string | null; transcript_updated_at?: string | null };
      const summary = await this.modelLineFor(row, row.projectId);
      const planMode = row.planMode === true;
      // The card this session builds, named the way the board names it
      // (`PHA-7`), resolved ONCE here where both facts are in hand.
      const project = await this.projectFacts(row.projectId);
      const card = row.card != null
        ? `${project.cardPrefix ? `${project.cardPrefix}-` : 'card '}${row.card}` : undefined;
      // Whose is the text in the box? /new cleared it before these calls ran,
      // so anything there now was typed FOR the session being built — it goes
      // with the new entry. Any other open was picked from an overlay over a
      // session the user was typing in: that text is parked on the one left.
      const onScreen = this.draftOnScreen();
      const prev = this.sessions.active();
      if (prev && target.kind !== 'new') prev.draft = onScreen;
      const resumed = [...agent.session.messages];
      this.sessions.add({
        ...(target.kind === 'new' ? { draft: onScreen } : {}),
        id: row.id, branch: row.branch, projectId: row.projectId,
        name: row.name ?? null,
        agent, summary,
        syncStamp: row.transcript_updated_at ?? null,
        planMode,
        pinned: row.pinned === true,
        ...(card ? { card } : {}),
        done: [
          ...bannerParts({ project: project.label, branch: row.branch }, summary),
          ...(project.error ? [{ kind: 'note', id: nextId('note'), text: project.error } as Part] : []),
          ...messagesToParts(resumed),
        ],
      });
      // An empty conversation opens on the splash, exactly as boot's does.
      this.splash = resumed.length === 0;
      this.opening = false;
      this.watchTasks();
      this.watchSession(row.id);
      this.notify();
      this.opts.onSession?.({ id: row.id, branch: row.branch, projectId: row.projectId });
      return true;
    } catch (e) {
      const what = target.kind === 'new'
        ? `could not start a session in ${this.wsLabel(target.projectId)}`
        : target.kind === 'duplicate' ? `could not duplicate session ${target.id}`
          : `could not open session ${target.id}`;
      this.opening = false;
      this.note(`${what}: ${(e as Error).message}`);
      return false;
    }
  };

  /** [d] on a session row: duplicate it. The copy opens on the source's
   *  model; /settings or a preset moves it until its first message, exactly as
   *  for a new session — one door for "this conversation, another model".
   *
   *  The list's own lock marker is the gate: a row the server said is held
   *  is refused HERE, on the picker — no menu close, no dead round-trip. The
   *  marker can be a poll behind, so this is only the shortcut: a stale
   *  "held" self-heals on the next refresh (kicked off right away), a stale
   *  "free" meets the server's 409 as before. */
  duplicateFromPicker = async (id: string): Promise<void> => {
    const row = this.picker?.sessions.find((s) => s.id === id);
    if (row?.locked) {
      this.pickerNotice = 'session is in use — stop it first, or wait for it to complete';
      this.notify();
      void this.refreshPicker().catch(quiet('refresh the session list'));
      return;
    }
    this.pickerNotice = undefined;   // the gate passed — no refusal to show
    this.dismissOverlay();
    await this.openSession({ kind: 'duplicate', id });
  };

  /** What the window CALLS a session when it must name one: the server name
   *  (auto-title or /rename), else its card (`PHA-7`), else its branch —
   *  never a bare session id. */
  private labelOf(e: LoadedSession): string { return e.name ?? e.card ?? e.branch; }

  /** THE close: a session leaves local memory. Nothing on the server changes,
   *  so opening it again gets it back exactly as it was. Every door ([x] on
   *  /resume, /close, the Assistant's session_close) comes through here.
   *  Refused while a turn runs there. Closing the one on screen hands the
   *  screen to whatever you spoke to most recently; closing the LAST one opens
   *  a fresh session in the same project, because close means "done with
   *  this", never "leave me looking at nothing". A timed flash on the
   *  toolbar confirms it; `quiet` is for doors that say their own (trash). */

  closeSession = async (id?: string, quiet = false): Promise<CloseResult> => {
    const target = id ?? this.sessions.activeId;
    if (!target) return { error: 'no session is open — nothing to close' };
    const e = this.sessions.get(target);
    if (!e) return { error: `session ${target} is not open in this window — nothing to close` };
    const { projectId } = e;
    const wasOnScreen = this.sessions.activeId === target;
    if (!this.sessions.close(target)) return { error: `a turn is running in ${target} — stop it first` };
    this.unwatchSession(target);
    let opened_new = false;
    if (wasOnScreen) {
      const next = this.sessions.list()[0];
      if (next) this.switchTo(next.id);
      else opened_new = await this.openSession({ kind: 'new', projectId });
      // Both of those restart the count's clock; a failed open leaves no
      // session on screen, and this is what clears the toolbar's count.
      if (!this.sessions.activeId) this.watchTasks();
      // The screen changed underfoot — say so, in the pane of the session
      // now on screen. AFTER the switch/open above: the note lands in
      // whatever those seated.
      if (!quiet) this.setToast('Session closed');
    }
    return { ok: true, closed: target, on_screen: this.sessions.activeId, opened_new };
  };

  // ── the menu screens ──────────────────────────────────────────────────────
  // The data behind the screens that do not fetch for themselves. They are fed
  // rather than self-fetching for one reason: every one of them opens
  // fetch-FIRST, so a server that cannot answer leaves you on the chat with a
  // note instead of on an empty screen. Two of them also need facts only this
  // window has — which sessions are open here, which is mid-turn, this
  // window's lock id.

  /** A rejected "add a project" stays on the form with the server's words. */
  addError: string | undefined;
  /** The project rows the switcher names its sessions with, fetched the
   *  first time a screen needs them and never at launch. */
  projectRows: ProjectInfo[] = [];
  /** The names the Assistant speaks with — the same cache, shared. */
  readonly projects: ProjectDirectory;

  /** `query` is the filter text these rows ANSWER (the screen's empty
   *  state reads it) — the live text is `pickerQuery`, which runs ahead.
   *  `filter` is the whole server query these rows answer (listQuery at
   *  the read): a refresh compares it to decide whether the list is the
   *  same one deeper, or a new one from its first page. */
  picker: { sessions: SessionInfo[]; total: number; end: boolean; query: string; filter: string } | null = null;
  pickerNotice: string | undefined;
  /** [s] on /resume: the background seats — supervisor sessions
   *  and cron runs — in the list or not. A fetch parameter, not a filter —
   *  the server decides what the list is. */
  showBackground = false;
  /** [/] on /resume: the filter line's text — like showBackground, a fetch
   *  parameter the server applies (one substring, anywhere in the name,
   *  the last message or the branch), never a local sieve over a page.
   *  Empty = no filter; cleared when the picker opens and when filter mode
   *  ends. */
  pickerQuery = '';
  /** ←→ on /resume: one project's sessions, or null for all of them.
   *  A fetch parameter like the two above; the `/` text searches inside it.
   *  Kept across opens like showBackground — the list comes back as you
   *  left it, and the footer key shows the filter is on. */
  pickerProject: string | null = null;
  private pickerQueryClock: ReturnType<typeof setTimeout> | null = null;
  private morePickerInFlight = false;

  tasks: TasksView | null = null;
  tasksNotice: string | undefined;
  /** The toolbar's count. Null only before the first read lands. */
  taskCount: number | null = null;

  archived: Card[] = [];
  archivedNotice: string | undefined;
  /** The whole archive's size (the server's count); `archived` is what is
   *  loaded, and the screen counts what is below against this. */
  archivedTotal: number | undefined;
  private archivedEnd = false;
  private moreArchivedInFlight = false;

  /** The task count's clock: restarted by a change of session, unref'd so
   *  it never holds the process open. */
  private taskClock: ReturnType<typeof setInterval> | null = null;

  // ── /resume and /project ────────────────────────────────────────────────

  /** The list's FILTERS are the server's (`typed`, `background`): a page is a
   *  page on screen, and `total` is the count for exactly these filters. */
  private listQuery(): string {
    return `typed=true${this.showBackground ? '' : '&background=false'}`
      + (this.pickerQuery.trim() ? `&q=${encodeURIComponent(this.pickerQuery.trim())}` : '')
      + (this.pickerProject ? `&project=${encodeURIComponent(this.pickerProject)}` : '');
  }

  /** ←→ on /resume: the next project round the ring — all, then each
   *  project in the order /project lists them (the server's), wrapping.
   *  The list re-reads at once; a project with no sessions shows as such. */
  cyclePickerProject(dir: 1 | -1): void {
    const ring: (string | null)[] = [null, ...this.projectRows.map((project) => project.id)];
    const at = ring.indexOf(this.pickerProject);
    this.pickerProject = ring[(Math.max(at, 0) + dir + ring.length) % ring.length] ?? null;
    this.notify();
    void this.refreshPicker().catch(quiet('refresh the session list'));
  }

  /** The filter line changed. The list re-reads a beat after the last
   *  keystroke, not on every one — a word typed at speed is one request.
   *  Clearing (esc) re-reads at once: the filtered rows with no filter
   *  would draw as an empty list for the length of the wait. */
  setPickerQuery(q: string): void {
    if (this.pickerQuery === q) return;
    this.pickerQuery = q;
    this.notify();
    if (this.pickerQueryClock) clearTimeout(this.pickerQueryClock);
    const read = () => { this.pickerQueryClock = null; void this.refreshPicker().catch(quiet('refresh the session list')); };
    if (!q) read();
    else this.pickerQueryClock = setTimeout(read, PICKER_FILTER_DEBOUNCE_MS);
  }

  /** Does an open-here row pass the filter? The server's rule (one
   *  substring, case-insensitive) applied to the two facts such a row has. */
  private matchesPickerQuery(e: LoadedSession): boolean {
    const q = this.pickerQuery.trim().toLowerCase();
    return (!this.pickerProject || e.projectId === this.pickerProject)
      && (!q || (e.name ?? '').toLowerCase().includes(q) || e.branch.toLowerCase().includes(q));
  }

  /** The one addition only this window can make: sessions open HERE that the
   *  server would leave out (nothing typed yet). Merged in, counted in — the
   *  switcher must never hide an open session. Server rows that ARE loaded
   *  locally get their tokens from this window's running count, which is
   *  ahead of the table while a turn's upload is in flight. The model is the
   *  row's, always — never a local guess over it. */
  private withOpenHere(rows: SessionInfo[], total: number) {
    const local = new Map(this.sessions.list().map((e) => [e.id, e]));
    const enriched = rows.map((s) => {
      const e = local.get(s.id);
      if (!e) return s;
      return { ...s,
        tokensInput: e.usage.input || s.tokensInput,
        tokensOutput: e.usage.output || s.tokensOutput,
        tokensCacheRead: e.usage.cacheRead || s.tokensCacheRead,
        tokensCacheWrite: e.usage.cacheWrite || s.tokensCacheWrite,
      };
    });
    const seen = new Set(rows.map((s) => s.id));
    const extras: SessionInfo[] = this.sessions.list()
      .filter((e) => !seen.has(e.id) && (e.lastMessageAt > 0 || e.pinned) && this.matchesPickerQuery(e))
      .map((e) => ({
        id: e.id, projectId: e.projectId, branch: e.branch, status: 'active', agent: 'coding', startedBy: 'person',
        model: e.summary.model, pinned: e.pinned,
        tokensInput: e.usage.input || null, tokensOutput: e.usage.output || null,
        tokensCacheRead: e.usage.cacheRead || null, tokensCacheWrite: e.usage.cacheWrite || null,
        // Nothing typed = no activity: it sorts LAST, never ahead of real work.
        lastUsedAt: new Date(e.lastMessageAt || 0).toISOString(), locked: false, lastUserMessage: null,
      }));
    return { sessions: [...enriched, ...extras], total: total + extras.length };
  }

  /** THE picker fetch — the only place the two lists are read. Throws on
   *  failure so each caller decides what that means: opening says so and stays
   *  put; a background refresh keeps quiet and keeps the list it has. A
   *  refresh re-reads however many rows are loaded, so what is on screen stays
   *  live however deep you have scrolled. A short page = the end. */
  refreshPicker = async (): Promise<void> => {
    // Reads overlap (the poll, the filter line, a keypress) and the network
    // does not keep them in order: only the newest read may land, or a slow
    // answer to "auth" would overwrite the list for "auth refactor".
    const seq = ++this.pickerSeq;
    // A changed filter is a new list: one page of it, not however deep the
    // old list was scrolled. The same filter re-reads what is loaded.
    const filter = this.listQuery();
    const want = filter !== this.picker?.filter
      ? PICKER_PAGE : Math.max(this.picker?.sessions.length ?? 0, PICKER_PAGE);
    // The project list is read ONCE, at open; after that the settings feed
    // says when a project row moved (create, patch, delete) and
    // settingChanged re-reads it into projectRows, which the screen draws.
    const [projects, got] = await Promise.all([
      this.picker ? this.projectRows : this.api('GET', '/projects') as Promise<ProjectInfo[]>,
      this.api('GET', `/sessions?${filter}&limit=${want}`),
    ]);
    if (seq !== this.pickerSeq) return;
    if (!this.picker) this.seeProjects(projects);
    const { sessions: ss, total } = got as { sessions: SessionInfo[]; total: number };
    this.picker = { ...this.withOpenHere(ss, total), end: ss.length < want, query: this.pickerQuery, filter };
    this.notify();
  };
  private pickerSeq = 0;

  /** The next page, appended in place. The cursor is the last SERVER row as
   *  this client saw it (the open-here extras carry no server position); a
   *  session's last_used_at only ever grows, so a row can move UP past the
   *  cursor and the refresh catches it at the top, but pages going down never
   *  repeat one. Failure keeps the loaded rows; scrolling again retries. */
  morePicker = async (): Promise<void> => {
    const p = this.picker;
    const tail = [...(p?.sessions ?? [])].reverse().find((r) => r.lastUserMessage !== null);
    if (!p || p.end || !tail || this.morePickerInFlight) return;
    this.morePickerInFlight = true;
    try {
      const got = await this.api('GET', `/sessions?${this.listQuery()}&limit=${PICKER_PAGE}`
        + `&before=${encodeURIComponent(tail.lastUsedAt)}&before_id=${tail.id}`
        + `&before_pinned=${tail.pinned === true}`) as
        { sessions: SessionInfo[]; total: number };
      const prev = this.picker;
      if (prev) {
        const seen = new Set(prev.sessions.map((s) => s.id));
        const rows = [...prev.sessions, ...got.sessions.filter((s) => !seen.has(s.id))];
        this.picker = { ...prev,
          ...this.withOpenHere(rows.filter((r) => r.lastUserMessage !== null), got.total),
          end: got.sessions.length < PICKER_PAGE };
        this.notify();
      }
    } catch (e) { quiet('load more sessions')(e); }
    finally { this.morePickerInFlight = false; }
  };

  /** Fetch first, THEN show — a server that cannot answer leaves you where you
   *  were with a note, never on an empty screen. */
  openPicker = async (which: 'project' | 'resume'): Promise<void> => {
    try {
      this.picker = null;   // an OPEN reads both lists fresh
      this.pickerQuery = '';
      await this.refreshPicker();
      this.pickerNotice = undefined;
      this.showOverlay(pickerScreen(this, which));
    } catch (e) {
      this.note(`could not list ${which === 'resume' ? 'sessions' : 'projects'}: ${(e as Error).message}`);
    }
  };

  /** The one pin write: /pin and [p] on /resume both come through here.
   *  The server row is the record; the local mirror follows so this window's
   *  open-here extras pin too. Throws on failure — each caller reports where
   *  it lives (a note in the session, the picker's notice line). */
  setPinned = async (id: string, on: boolean): Promise<void> => {
    await this.api('PATCH', `/sessions/${id}`, { pinned: on });
    this.sessions.setPinned(id, on);
  };

  /** [p] on /resume: pin the row to the top of the list (or take it down).
   *  The row in hand says which way the toggle goes; the re-read draws it. */
  pinFromPicker = async (id: string): Promise<void> => {
    const row = this.picker?.sessions.find((s) => s.id === id);
    const on = !(row?.pinned ?? false);
    try {
      await this.setPinned(id, on);
      this.pickerNotice = undefined;
      await this.refreshPicker().catch(quiet('refresh the session list'));
    } catch (e) {
      this.pickerNotice = `could not pin session ${id}: ${(e as Error).message}`;
    }
    this.notify();
  };

  /** [i] on /resume: ping the session — start its container and mark the
   *  checkout used, so its git status can be checked again and the idle
   *  reaper leaves it up. The server's periodic refresh updates the column live. */
  pingSession = async (id: string): Promise<void> => {
    try {
      await this.api('POST', `/sessions/${id}/ping`, {});
      this.pickerNotice = 'pinging container — git status updates shortly';
    } catch (e) {
      this.pickerNotice = `could not ping session: ${(e as Error).message}`;
    }
    this.notify();
  };

  /** /resume follows the session list feed while up: any row moving
   *  anywhere re-reads the loaded rows (coalesced); a reconnect re-reads
   *  too, since notices were missed. No stream (tests) = the list stands
   *  as read at open. Returns the stop. */
  watchPicker = (): (() => void) => {
    if (!this.opts.stream) return () => {};
    const feed = new SessionsFeed(this.opts.stream,
      () => { void this.refreshPicker().catch(quiet('refresh the session list')); });
    feed.start();
    return () => feed.stop();
  };

  /** [s] on /resume: flip the filter and re-read. */
  toggleBackground(): void {
    this.showBackground = !this.showBackground;
    this.notify();
    void this.refreshPicker().catch(quiet('refresh the session list'));
  }

  /** [x] on /resume: the close path, its result on the picker's own notice
   *  line, where the list is. */
  closeFromPicker = async (id: string): Promise<void> => {
    const r = await this.closeSession(id);
    if ('error' in r) {
      this.pickerNotice = r.error.includes('a turn is running')
        ? 'a turn is running there — esc stops it, then [x]' : r.error;
    } else {
      this.pickerNotice = r.opened_new
        ? 'closed the last one — a new session is open behind this list'
        : 'closed — enter opens it again';
    }
    this.notify();
  };

  /** The one destructive call. The confirm goes UNFORCED — the server pushes
   *  first (the flush) and refuses if work would still be lost. The two
   *  refusals come back as names; anything else throws. */
  private async purgeSession(id: string, force: boolean): Promise<'ok' | 'unpushed_work' | 'session_locked'> {
    try {
      await this.api('DELETE', `/sessions/${id}?purge=true${force ? '&force=true' : ''}`);
      return 'ok';
    } catch (e) {
      const m = (e as Error).message;
      const code = (e as { code?: string }).code ?? '';
      if (code === 'unpushed_work' || m.includes('unpushed_work')) return 'unpushed_work';
      if (code === 'session_locked' || m.includes('session_locked')) return 'session_locked';
      throw e;
    }
  }

  /** THE trash, for both doors — [t] on /resume and /trash in the chat. The
   *  dialog asks first; yes lets the window's own copy go (its hold would
   *  lock the purge — the same switch-over /close uses), then the DELETE
   *  runs. The unpushed-work refusal asks ONCE more, at force, so the
   *  second yes discards knowingly. The session leaves the server for good:
   *  row, transcript, files; only its pushed branch on origin survives.
   *  `say` is where each door reports — the picker's notice line, or the
   *  pane and a toast. */
  private trash = async (id: string, label: string,
    say: { refuse: (t: string) => void; done: () => void }, force = false): Promise<void> => {
    const yes = force
      ? await this.confirm('unpushed work — discard it?', 'commits on this branch never reached origin; they go with the session')
      : await this.confirm(`trash "${label}" for good?`, 'the row, the transcript, the files — gone for good');
    if (!yes) return;
    if (this.sessions.has(id)) {
      const r = await this.closeSession(id, true);
      if ('error' in r) { say.refuse(`not trashed — ${r.error}`); return; }
    }
    let verdict: 'ok' | 'unpushed_work' | 'session_locked';
    try { verdict = await this.purgeSession(id, force); }
    catch (e) { say.refuse(`could not trash session ${id}: ${(e as Error).message}`); return; }
    if (verdict === 'unpushed_work') await this.trash(id, label, say, true);
    else if (verdict === 'session_locked') say.refuse('in use elsewhere — a held session cannot be trashed');
    else say.done();
  };

  /** [t] on /resume. */
  trashSession = (id: string): Promise<void> => {
    const row = this.picker?.sessions.find((r) => r.id === id);
    return this.trash(id, row?.name ?? row?.branch ?? id, {
      refuse: (t) => { this.pickerNotice = t; this.notify(); },
      done: () => {
        this.pickerNotice = undefined;
        // The trash landed; a failed re-read must not report "could not trash".
        void this.refreshPicker().catch(quiet('refresh the session list'));
      },
    });
  };

  /** /trash in the chat: the session on screen. */
  private trashActive = (e: LoadedSession): Promise<void> =>
    this.trash(e.id, this.labelOf(e), { refuse: this.note, done: () => this.setToast('Session trashed') });

  /** ctrl+n: the sessions open in this window. It shows FIRST and fills the
   *  project names in behind — the rows read fine as ids until they land. */
  openSwitcher(): void {
    this.showOverlay(switcherScreen(this));
    if (this.projectRows.length) return;
    void (async () => {
      try { this.seeProjects(await this.api('GET', '/projects') as unknown as ProjectInfo[]); this.notify(); }
      catch (e) { this.note(`could not list projects: ${(e as Error).message}`); }
    })();
  }

  /** `/new <project>` and `/project <project>`: the rows the slash
   *  menu offers — the card prefix (`PHA`, the status bar's and /resume's
   *  name for a project) and the repo (`owner/name`), nothing twice. Tab
   *  fills the repo name, never the prefix: prefixes are three letters and
   *  two repos can share one. The one you are in leads and says so; the
   *  rest in the server's order, the same order /project lists them. Read
   *  on every keystroke and render, so it only READS: projectRows is
   *  filled by boot, the pickers and the settings feed, never from here. */
  argChoices: Choices = () => {
    const here = this.sessions.active()?.projectId;
    const row = (project: ProjectInfo) => ({
      name: project.cardPrefix ?? label(project), fill: project.name,
      summary: `${project.owner}/${project.name}${project.id === here ? ' · here' : ''}`,
    });
    return [...this.projectRows.filter((project) => project.id === here), ...this.projectRows.filter((project) => project.id !== here)].map(row);
  };

  /** The project a typed argument names — the repo name tab fills, or
   *  anything else a row showed: `owner/name`, the card prefix, the display
   *  name. Case does not matter. One project, or the reason there is not:
   *  a shared prefix names two and the note lists them by repo, which is
   *  what to type instead. */
  private findProject(arg: string): ProjectInfo | { error: string } {
    const typed = arg.toLowerCase();
    const names = (project: ProjectInfo) => [project.name, `${project.owner}/${project.name}`, project.cardPrefix, project.displayName];
    const hits = this.projectRows.filter((project) => names(project).some((n) => n?.toLowerCase() === typed));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return { error: `"${arg}" is ambiguous: ${hits.map((project) => `${project.owner}/${project.name}`).join(', ')}` };
    return { error: `unknown project "${arg}" — /project lists them` };
  }

  /** One project list, three consumers: the switcher's rows, the banner's
   *  name cache, and the names the Assistant speaks with. */
  private seeProjects(rows: ProjectInfo[]): void {
    this.projectRows = rows;
    this.seedWsFacts(rows);
    this.projects.offer(rows);
    this.notify();
  }

  /** `e` on a /project row: that project's settings, on their own screen
   *  (its close reopens the list). */
  editProject(id: string): void {
    const project = this.projectRows.find((x) => x.id === id);
    if (project) this.showOverlay(projectSettingsScreen(this, project));
  }

  /** The add form, with any previous complaint cleared. */
  startAddProject(): void { this.addError = undefined; this.showOverlay(addProjectScreen(this)); }

  /** The add form's submit. Adding a project is only useful if you then work
   *  in it, so it opens a session there; the confirmation goes AFTER that
   *  switch, into the session you land in, because noting it first writes it
   *  to the session you are leaving where the switch wipes it off unread. A
   *  rejected POST stays on the form with the server's own words, which
   *  distinguish already_exists from a token that cannot create. */
  addProject = async (req: NewProjectRequest): Promise<void> => {
    // Cleared before the call so a second failure with the SAME message is
    // still a change of the error the form sees.
    this.addError = undefined;
    this.notify();
    try {
      const project = await this.api('POST', '/projects', req) as { id: string; owner: string; name: string };
      this.dismissOverlay();
      await this.openSession({ kind: 'new', projectId: project.id });
      this.note(`project ${project.owner}/${project.name} added`);
    } catch (e) {
      // The form is still up and reads this on its next draw — it is NOT
      // re-shown, which would remount it and lose what was typed.
      this.addError = (e as Error).message.replace(/^POST \/projects: /, '');
      this.notify();
    }
  };

  // ── /tasks ────────────────────────────────────────────────────────────────

  /** What is running in the session's container: the /tasks rows and the
   *  toolbar's count, from one read. The server reads the container fresh on
   *  every ask, so this is never a stored guess going stale. */
  refreshTasks = async (): Promise<void> => {
    const id = this.sessions.activeId;
    if (!id) return;
    const r = await this.api('GET', `/sessions/${id}/tasks`) as unknown as TasksView;
    this.tasks = r;
    this.taskCount = r.tasks.length;
    this.notify();
  };

  /** The count's own clock: seeded when a session lands on screen, then once a
   *  minute while the window idles. Turn ends and the open /tasks screen
   *  refresh it more often. A failed tick keeps the last count — an
   *  unreachable server must not blank the toolbar. */
  private watchTasks(): void {
    if (this.taskClock) { clearInterval(this.taskClock); this.taskClock = null; }
    // No session on screen: the toolbar's count is not stale, it is absent.
    if (!this.sessions.activeId) { this.taskCount = null; this.tasks = null; this.notify(); return; }
    void this.refreshTasks().catch(quiet('refresh tasks'));
    this.taskClock = setInterval(() => { void this.refreshTasks().catch(quiet('refresh tasks')); },
      this.opts.taskPollMs ?? 60_000);
    this.taskClock.unref?.();
  }

  openTasks = async (): Promise<void> => {
    if (!this.sessions.activeId) { this.note("no session is open — tasks run in a session's container"); return; }
    try {
      await this.refreshTasks();
      this.tasksNotice = undefined;
      this.showOverlay(tasksScreen(this));
    } catch (e) { this.note(`could not list tasks: ${(e as Error).message}`); }
  };

  // ── the session feeds ────────────────────────────────────────────────────
  // ONE feed per OPEN session, not one following the eye: every session in
  // this window hears what happens to it elsewhere (a server-run agent, a
  // Telegram turn, another window's relay, a lock or a plan flip) as it
  // happens, instead of discovering it on switch. Only the session on screen
  // repaints — the store's fold already paints the active id alone — so a
  // busy background turn costs its connection and its parts, never a redraw.
  // The server does not echo a window its own events, so nothing here
  // double-draws a turn this window runs.
  private feeds = new Map<string, SessionFeed>();

  /** Open the session's feed (idempotent). No stream (tests, a server too
   *  old to have one) = no feed; the switch-time re-read stays the backstop.
   *  The store is a PARAMETER: the constructor's seat runs before
   *  `this.sessions` is assigned, so reading it here would hand the feed
   *  nothing. */
  private watchSession(id: string, store: SessionStore = this.sessions): void {
    if (!this.opts.stream || this.feeds.has(id)) return;
    const feed = new SessionFeed(this.opts.stream, id, store, {
      // Neither hook catches: a failed refill must REJECT into followStream,
      // which closes the link and reconnects onto a fresh snapshot. Swallowing
      // it here left the window on stale state for ever once the poll that
      // used to be the backstop was removed.
      onRecordLanded: (updatedAt, keepScreen) =>
        this.refreshIfMoved(id, updatedAt || null, keepScreen),
      onPlanModeChanged: (on) => this.applyPlanMode(id, on),
      onModelChanged: async () => {
        const e = store.get(id);
        if (!e) return;
        const row = await this.api('GET', `/sessions/${id}`) as { provider?: string | null; model?: string | null };
        store.setModelLine(id, await this.modelLineFor(row, e.projectId));
      },
      // Named, because the toast is the window's, not the session's: a
      // failure on a session in the background says which one.
      onSyncFailed: (op, reason) => {
        const e = store.get(id);
        this.setToast(`${e ? `${this.labelOf(e)}: ` : ''}instant ${op} failed — ${reason}`);
      },
    });
    this.feeds.set(id, feed);
    feed.start();
  }

  /** Close the session's feed — the session left the window. */
  private unwatchSession(id: string): void {
    this.feeds.get(id)?.stop();
    this.feeds.delete(id);
  }

  /** [k] on /tasks: the dialog asks, then TERM, a second, then KILL — the
   *  whole tree. */
  killTask = async (sid: string, command: string): Promise<void> => {
    const id = this.sessions.activeId;
    if (!id) return;
    if (!(await this.confirm(`kill "${command}"?`, 'TERM, a second, then KILL — the whole process tree'))) return;
    try {
      await this.api('DELETE', `/sessions/${id}/tasks/${sid}`);
      this.tasksNotice = undefined;
      // The kill landed; a failed re-read must not report "could not kill".
      await this.refreshTasks().catch(quiet('refresh tasks'));
    } catch (e) {
      this.tasksNotice = `could not kill "${command}": ${(e as Error).message}`;
    }
    this.notify();
  };

  // ── /archived ─────────────────────────────────────────────────────────────

  /** The project's archived cards, fetched for the screen alone: the board
   *  GET never carries the archive, because the board does not render it and
   *  the archive grows forever while the board stays small. Pages like
   *  /resume. Shared with the board's [v]. */
  openArchived = async (projectId: string): Promise<void> => {
    try {
      const d = await this.api('GET',
        `/projects/${projectId}/cards?archived=only&limit=${PICKER_PAGE}`) as { cards: Card[]; total?: number };
      this.archivedEnd = d.cards.length < PICKER_PAGE;
      this.archived = d.cards;
      this.archivedTotal = d.total;
      this.archivedNotice = undefined;
      this.showOverlay(archivedScreen(this, projectId));
    } catch (e) { this.note(`could not list archived cards: ${(e as Error).message}`); }
  };

  /** The next page, appended in place — morePicker's shape. */
  moreArchived = async (projectId: string): Promise<void> => {
    const tail = this.archived[this.archived.length - 1];
    if (this.archivedEnd || !tail || this.moreArchivedInFlight) return;
    this.moreArchivedInFlight = true;
    try {
      const d = await this.api('GET', `/projects/${projectId}/cards?archived=only&limit=${PICKER_PAGE}`
        + `&before=${encodeURIComponent(tail.updated_at)}&before_id=${tail.id}`) as { cards: Card[]; total?: number };
      this.archivedEnd = d.cards.length < PICKER_PAGE;
      this.archivedTotal = d.total;
      const seen = new Set(this.archived.map((t) => t.id));
      this.archived = [...this.archived, ...d.cards.filter((t) => !seen.has(t.id))];
      this.notify();
    } catch (e) { quiet('load more archived cards')(e); }
    finally { this.moreArchivedInFlight = false; }
  };

  /** [r] on /archived: a direct PATCH, and the notice names the destination.
   *  The card returns to the column it was archived from, which can wake the
   *  looper. */
  restoreCard = async (projectId: string, card: Card): Promise<void> => {
    try {
      await this.api('PATCH', `/projects/${projectId}/cards/${card.id}`, { archived: false });
      this.archived = this.archived.filter((x) => x.id !== card.id);
      this.archivedNotice = `restored ${card.number}-${card.title} → ${card.status.replace(/_/g, ' ')}`;
      void this.boardFor(projectId).load();   // the card is back on the board
    } catch (e) { this.archivedNotice = `restore failed: ${(e as Error).message}`; }
    this.notify();
  };

  /** [enter] on /archived: the solo editor renders from the board store, which
   *  never holds archived cards on its own — seat this one first. */
  openArchivedCard = (projectId: string, card: Card): void => {
    this.boardFor(projectId).adoptCard(card);
    // esc from here is the chat: the archive screen it came from is a menu,
    // and going "back" to a board the user never opened would be a surprise.
    this.openCard(card.number, 'chat');
  };

  // ── git ───────────────────────────────────────────────────────────────────

  /** AUTO-PUSH, one path for both doors — `/auto-push` and the Assistant's
   *  `git_auto_push`. Every step and the outcome land as notes in the pushed
   *  session's pane (where the builder watches a push); the outcome is also
   *  returned, for the door that can say it. Never throws: a failure is a
   *  result too. */
  runAutoPush = async (id: string): Promise<{ result: string; reason?: string; sha?: string }> => {
    const say = (t: string) => this.sessions.note(id, t);
    if (!this.opts.autoPush) {
      say('auto-push is unavailable in this build');
      return { result: 'error', reason: 'auto-push is unavailable in this build' };
    }
    say('auto-push: starting');
    try {
      const r = await this.opts.autoPush(id, (label) => say(`auto-push: ${label}`));
      if (r.result === 'pushed') say(`auto-push: landed on the base branch (${(r.sha ?? '').slice(0, 10)})`);
      else if (r.result === 'nothing') say('auto-push: nothing to push — the base branch already has it all');
      else say(`auto-push: ${r.result}${r.reason ? ` — ${r.reason}` : ''}`);
      return r;
    } catch (e) {
      say(`auto-push failed: ${(e as Error).message}`);
      return { result: 'error', reason: (e as Error).message };
    }
  };

  /** AUTO-PULL: base INTO the session's branch. Same shape as auto-push. */
  runAutoPull = async (id: string) => {
    const say = (t: string) => this.sessions.note(id, t);
    if (!this.opts.autoPull) {
      say('auto-pull is unavailable in this build');
      return { result: 'error', reason: 'auto-pull is unavailable in this build' };
    }
    say('auto-pull: starting');
    try {
      const r = await this.opts.autoPull(id, (label) => say(`auto-pull: ${label}`));
      if (r.result === 'merged') {
        say(`auto-pull: ${r.arrived?.length ?? 0} commit${r.arrived?.length === 1 ? '' : 's'} from the base branch merged in`
          + `${r.files?.length ? ` — ${r.files.length} file${r.files.length === 1 ? '' : 's'} changed` : ''}`
          + `${r.pushed === false ? ` (${r.reason ?? 'branch push failed'})` : ''}`);
      } else if (r.result === 'clean') say('auto-pull: nothing to pull — the branch already has all of base');
      else say(`auto-pull: ${r.result}${r.reason ? ` — ${r.reason}` : ''}`);
      return r;
    } catch (e) {
      say(`auto-pull failed: ${(e as Error).message}`);
      return { result: 'error', reason: (e as Error).message };
    }
  };

  // ── the Assistant, and the settings everything reads again ────────────────

  /** The two chrome values a frame needs: is the voice pane on, and how wide.
   *  Read once when they change, never held as a settings object. */
  voiceEnabled: boolean;
  sidebarWidth: number;

  /** Whether the pane is drawn: the ctrl+g override, else the setting. */
  get showSidebar(): boolean { return this.sidebar ?? this.voiceEnabled; }

  private get assistantDeps() {
    return { api: this.api, clientId: this.opts.clientId ?? '', projects: this.projects };
  }

  /** Voice follows the setting: on at launch when enabled, stopped with the
   *  window. READ AT SPAWN — the sidecar takes its Deepgram key from the
   *  environment it is started with, so reading it here (not at app boot) is
   *  what lets you save the key, turn the Assistant on, and have it work the
   *  first time. A bad agent trio throws at build; say so rather than dying in
   *  a floating promise. */
  startVoice(current?: Record<string, ConfigValue>): void {
    void (async () => {
      let audio: Record<string, ConfigValue>;
      try {
        audio = current ?? await this.readSettings();
        await this.rebuildAssistant(true);
      } catch (e) { this.note(`assistant not started: ${(e as Error).message}`); return; }
      void this.voice.start(sidecarEnv(audio));
    })();
  }

  /** The Assistant's agent. Made ONCE per window, the first time a session
   *  is on screen (null before — the engine can start before any session
   *  opens): a conversation-only session on the on-screen session's workspace,
   *  with this window's kit. Re-pointed (`follow`) on every switch after,
   *  which App fires. */
  private assistant: AssistantAgent | null = null;

  /** The Assistant follows the session on screen: made if it does not
   *  exist yet, re-pointed if it does. `starting` = the engine is about to
   *  start, so "not running" is no reason to skip, and a failure is the
   *  caller's to report. */
  async rebuildAssistant(starting = false): Promise<void> {
    if (!starting && !this.voice.running) return;
    try {
      const active = this.sessions.active();
      if (!active) return;
      if (this.assistant) {
        await this.assistant.follow(active.projectId, active.id);
        return;
      }
      const agent = await AssistantAgent.newSession(this.opts.backend(), this.voice.handlers(),
        { projectId: active.projectId, activeSessionId: active.id });
      agent.addToolKit(assistantToolKit(this, this.assistantDeps));
      this.assistant = agent;
      this.voice.setAgent(agent);
    } catch (e) {
      if (starting) throw e;
      this.note(`assistant not pointed at this session: ${(e as Error).message}`);
    }
  }

  /** Launch: the chrome's two values and the voice decision, from one read. */
  async readChrome(): Promise<void> {
    try {
      const c = await this.readSettings();
      this.voiceEnabled = Boolean(c.voice_enabled);
      this.sidebarWidth = Number(c.sidebar_width) || (this.opts.sidebarPercent ?? 20);
      this.notify();
      if (c.voice_enabled) this.startVoice(c);
    } catch { /* index.tsx already refused to start without the server */ }
  }

  /** Another client wrote settings: make open menus re-read, then refresh
   *  every consumer from the server. The event carries no values. */
  private settingsWrittenElsewhere(): void {
    this.settingsVersion += 1;
    this.notify();
    this.settingChanged();
  }

  /** A setting changed. Everything that consumes one READS IT AGAIN here —
   *  rebuilding an agent, restarting the sidecar, pushing a live switch.
   *  Nothing is recomputed from a copy taken earlier, which is what used to
   *  leave the Assistant running on the settings it was born with. */
  settingChanged = (key?: string): void => {
    void (async () => {
      let cfg: Record<string, ConfigValue>;
      try { cfg = await this.readSettings(); }
      catch (e) { this.note(`could not read settings: ${(e as Error).message}`); return; }
      this.voiceEnabled = Boolean(cfg.voice_enabled);
      this.sidebarWidth = Number(cfg.sidebar_width) || (this.opts.sidebarPercent ?? 20);

      // A session's agent reads its model and tools from the server at
      // every turn start; nothing here is rebuilt. A model setting reaches
      // a session only through its row (Sessions.followModelSettings), and
      // the session feed brings that into the banner.

      // The Assistant follows its settings: on/off starts and stops it; an
      // audio value (the Deepgram key, the devices) restarts the sidecar,
      // which reads them again as it spawns; the spoken voice, the mutes,
      // headphones and the wake word are pushed live; ANY OTHER server
      // setting rebuilds the brain in place from the server's config — the
      // history stays, the next turn uses the new model. No list here of
      // which keys shape the assistant: the server owns that rule.
      const running = this.voice.running;
      if (key === undefined) {
        // A server event names no key: every consumer re-reads. Project and
        // board rows carry resolved settings too (card prefix, loop defaults).
        this.projectNames.clear();
        void this.api('GET', '/projects')
          .then((projects) => this.seeProjects(projects as unknown as ProjectInfo[]))
          .catch(quiet('reload project settings'));
        for (const b of this.boards.values()) void b.load().catch(quiet('reload board settings'));
        if (cfg.voice_enabled) this.startVoice(cfg);
        else { this.voice.stop(); this.sidebar = null; }
      } else if (key === 'voice_enabled') {
        if (cfg.voice_enabled) this.startVoice(cfg); else this.voice.stop();
        this.sidebar = null;
      } else if (running && key && VOICE_BOOT_KEYS.includes(key)) {
        this.startVoice(cfg);
      } else if (running && key === 'voice_spoken_voice') {
        this.voice.update({ voice: String(cfg.voice_spoken_voice) });
      } else if (running && key === 'voice_mic_muted') {
        this.voice.setMic(Boolean(cfg.voice_mic_muted));
      } else if (running && key === 'voice_speaker_muted') {
        this.voice.setSpeaker(Boolean(cfg.voice_speaker_muted));
      } else if (running && key === 'voice_headphones') {
        this.voice.setHeadphones(Boolean(cfg.voice_headphones));
      } else if (running && (key === 'voice_wake_word' || key === 'voice_wake_words' || key === 'voice_wake_timeout')) {
        this.voice.setWake(Boolean(cfg.voice_wake_word), String(cfg.voice_wake_words ?? ''),
          Number(cfg.voice_wake_timeout) || undefined);
      } else if (running && key && !isLocalKey(key)) {
        await this.rebuildAssistant();
      }
      this.notify();
    })();
  };

  /** The one voice-switch toggle — /mic /speaker /headphones /wake, ctrl+r and
   *  ctrl+l, and a click on either of the pane's switch rows. Every switch IS
   *  a setting: the toggle writes it and goes through settingChanged, the same
   *  path the /assistant screen takes, which is what keeps the screen and the
   *  toggle from diverging. The state holds across engine and TUI restarts. */
  toggleDevice = (which: 'mic' | 'speaker' | 'headphones' | 'wake'): void => {
    if (!this.voice.running) { this.note('voice is off — /assistant to turn it on'); return; }
    const key = SWITCH_KEY[which];
    void (async () => {
      // Read the switch, flip it, write it, then let settingChanged read
      // everything again. A toggle is a read-modify-write, so it reads.
      let cfg: Record<string, ConfigValue>;
      try { cfg = await this.readSettings(); }
      catch (e) { this.note(`could not read settings: ${(e as Error).message}`); return; }
      const now = !cfg[key];
      try { await this.settings.write(key, now); }
      catch (e) { this.note(`could not save ${key}: ${(e as Error).message}`); return; }
      this.settingChanged(key);
      switch (which) {
        case 'mic': this.note(now ? 'voice: not listening' : 'voice: listening'); break;
        case 'speaker': this.note(now ? 'voice: quiet — text only' : 'voice: speaking again'); break;
        case 'headphones':
          this.note(now ? 'voice: headphones on — talk over it'
            : 'voice: headphones off — over speakers, the mic is muted while it speaks');
          break;
        case 'wake':
          this.note(now ? `voice: waiting for the wake word (${String(cfg.voice_wake_words ?? '')})`
            : 'voice: wake word off — it answers everything it hears');
          break;
      }
    })();
  };

  // ── the slash commands ────────────────────────────────────────────────────

  /** Every slash command, in one place. The prompt calls `submit`; this is
   *  what it resolves to. */
  runCommand = async (name: string, args = ''): Promise<void> => {
    const session = this.sessions.active();
    switch (name) {
      case 'new': {
        // Named: that project (findProject takes anything a row showed).
        // Not named and no session yet = no project to mean "here": the
        // picker chooses. openSession clears the pane and puts the splash up before
        // the network calls run.
        if (args) {
          const project = this.findProject(args);
          if ('error' in project) { this.note(project.error); return; }
          await this.openSession({ kind: 'new', projectId: project.id });
        } else if (session) await this.openSession({ kind: 'new', projectId: session.projectId });
        else await this.openPicker('project');
        return;
      }
      case 'resume': await this.openPicker('resume'); return;
      case 'close': {
        const r = await this.closeSession();
        if ('error' in r) {
          this.note(r.error.includes('a turn is running')
            ? 'a turn is running here — esc stops it, then /close' : r.error);
        }
        return;
      }
      case 'duplicate':
        if (!session) { this.note('no session is open — nothing to duplicate'); return; }
        if (session.busy || session.remoteBusy) {
          this.note('a turn is running — wait for it to finish, then /duplicate');
          return;
        }
        await this.openSession({ kind: 'duplicate', id: session.id });
        return;
      case 'trash':
        if (!session) { this.note('no session is open — nothing to trash'); return; }
        await this.trashActive(session);
        return;
      case 'project': {
        // Named: that project's settings — the screen `e` opens on its
        // picker row, one tab away instead of a list and a keypress. Bare:
        // the picker, to start a session somewhere else.
        if (args) {
          const project = this.findProject(args);
          if ('error' in project) { this.note(project.error); return; }
          this.editProject(project.id);
        } else await this.openPicker('project');
        return;
      }
      case 'rename': {
        if (!session) { this.note('no session is open — nothing to rename'); return; }
        try {
          await this.api('PATCH', `/sessions/${session.id}`, { name: args || null });
          this.sessions.setName(session.id, args || null);
          this.note(args ? `renamed: ${args}` : 'name cleared — auto-titles are back on');
        } catch (e) { this.note(`could not rename session ${session.id}: ${(e as Error).message}`); }
        return;
      }
      case 'pin': {
        if (!session) { this.note('no session is open — nothing to pin'); return; }
        const on = !session.pinned;
        try {
          await this.setPinned(session.id, on);
          this.note(on ? 'pinned — to the top of /resume' : 'unpinned');
        } catch (e) { this.note(`could not pin session ${session.id}: ${(e as Error).message}`); }
        return;
      }
      case 'done': {
        // Unpin, then close — the pin is checked off the row first so a
        // finished session never lingers at the top of /resume. The busy
        // guard runs before the unpin so a refused close leaves the pin as
        // it was.
        if (!session) { this.note('no session is open — nothing to finish'); return; }
        if (session.busy || session.remoteBusy) {
          this.note('a turn is running here — esc stops it, then /done');
          return;
        }
        if (session.pinned) {
          try { await this.setPinned(session.id, false); }
          catch (e) { this.note(`could not unpin session ${session.id}: ${(e as Error).message}`); return; }
        }
        const r = await this.closeSession();
        if ('error' in r) this.note(r.error);
        return;
      }
      case 'kanban': this.openBoard(); return;
      case 'archived':
        if (!session) { this.note('no session is open — archived cards belong to a project; /project starts a session in one'); return; }
        await this.openArchived(session.projectId);
        return;
      case 'tasks': await this.openTasks(); return;
      case 'plan': {
        if (!session) { this.note('no session is open — nothing to switch'); return; }
        if (session.planMode) { this.note('already in plan mode'); return; }
        try {
          await this.api('PATCH', `/sessions/${session.id}`, { plan_mode: true });
          await this.applyPlanMode(session.id, true);
        } catch (e) { this.note(`could not enter plan mode: ${(e as Error).message}`); }
        return;
      }
      case 'code': {
        if (!session) { this.note('no session is open — nothing to switch'); return; }
        if (!session.planMode) { this.note('already in code mode'); return; }
        try {
          await this.api('PATCH', `/sessions/${session.id}`, { plan_mode: false });
          await this.applyPlanMode(session.id, false);
        } catch (e) { this.note(`could not enter code mode: ${(e as Error).message}`); }
        return;
      }
      case 'compact':
        // Compaction is the server's, on the record — not built
        // (sdk-conversion.md item 6).
        if (args.trim().toLowerCase() === 'assistant') {
            this.note('compaction is not available for the Assistant yet');
          return;
        }
        this.note('compaction is not available for coding sessions yet');
        return;
      case 'auto-push':
        if (!session) { this.note('no session is open — nothing to push'); return; }
        // Detached: a push can run for minutes and the prompt never locks.
        void this.runAutoPush(session.id);
        return;
      case 'auto-pull':
        if (!session) { this.note('no session is open — nothing to pull into'); return; }
        void this.runAutoPull(session.id);
        return;
      case 'settings': this.showOverlay(settingsScreen(this)); return;
      case 'keys': this.showOverlay(keysScreen(this)); return;
      case 'secrets': this.showOverlay(secretsScreen(this)); return;
      case 'presets': this.showOverlay(presetsScreen(this)); return;
      case 'server': this.showOverlay(serverScreen(this)); return;
      case 'cpu': {
        try {
          const r = await this.api('GET', '/system/status') as { text?: string; warnings?: string };
          this.note([r.text || '(empty status)', r.warnings ? `warnings: ${r.warnings}` : ''].filter(Boolean).join('\n'));
        } catch (e) { this.note(`could not read the server status: ${(e as Error).message}`); }
        return;
      }
      case 'tokens': {
        try {
          const r = await this.api('GET', '/system/token-usage') as { text?: string };
          this.note(r.text || '(no usage data)');
        } catch (e) { this.note(`could not read token usage: ${(e as Error).message}`); }
        return;
      }
      case 'restart': {
        // A restart cuts every in-flight turn, so it is never one keystroke away.
        const svc = args || null;
        const yes = svc ? await this.confirm(`restart ${svc}?`)
          : await this.confirm('restart the server?', 'the api — everything is offline for a few seconds');
        if (!yes) return;
        try {
          await this.api('POST', '/system/restart', svc ? { service: svc } : {});
          this.note(svc ? `restarting ${svc}`
            : 'restarting the api — back in a few seconds (the window reconnects on its own)');
        } catch (e) { this.note(`could not restart: ${(e as Error).message}`); }
        return;
      }
      case 'assistant':
        this.showOverlay(settingsScreen(this, 'assistant'));
        // The mic and speaker pickers want device names; with voice off, ask.
        void this.voice.refreshDevices();
        return;
      case 'mic': this.toggleDevice('mic'); return;
      case 'speaker': this.toggleDevice('speaker'); return;
      case 'headphones': this.toggleDevice('headphones'); return;
      case 'wake': this.toggleDevice('wake'); return;
      case 'ask':
        if (!args) { this.note('/ask <what to tell the Assistant>'); return; }
        if (!this.voice.say(args)) this.note('voice is off — /assistant to turn it on');
        else if (this.sidebar === false) { this.sidebar = null; this.notify(); }
        return;
      case 'pop': {
        if (!session) { this.note('no session is open'); return; }
        if (!session.agent.userMessages.length) { this.note('the queue is empty — nothing to pop'); return; }
        if (args === 'all') {
          const all = session.agent.userMessages.pending().map((e) => e.text).filter(Boolean).join('\n\n');
          this.sessions.clearQueue(session.id);
          this.setPrompt(all);
          return;
        }
        const removed = this.sessions.unqueue(session.id);
        if (removed) this.setPrompt(removed);
        return;
      }
      case 'help':
        this.note(COMMANDS.map((c) => `  /${c.name.padEnd(10)} ${c.summary}`).join('\n'));
        return;
      case 'exit': this.quit(); return;
    }
  };

  /** A submitted line: a command, a message, or a refusal.
   *
   *  `accept` is called the moment the line is going to be acted on, and the
   *  prompt clears THEN — not before, so a refused line stays in the box to
   *  edit or resend, and not after, because the work can take a while and a
   *  session switch inside it would park the unsent text on the session being
   *  left (a `/new` came back as the old session's draft).
   *
   *  `highlighted` is the row the slash menu has under the cursor, so enter
   *  runs THAT command rather than the half-typed text that produced the list. */
  submit = async (text: string, highlighted = 0, accept: () => void = () => {}): Promise<void> => {
    // Chips become their pasted text here, before the line is anything else —
    // so no command, message or transcript ever sees a literal chip. A chip
    // whose text is gone (recalled from an earlier run) is stripped; a plain
    // message is sent without it, but a slash command or an empty line is
    // refused — silently dropping part of a command changes what it runs.
    const expanded = this.pastes.expand(text);
    // The trailing space is MEANING on a slash line: `/new ` is the project
    // list, `/new` is the command list, and the highlighted row is an index
    // into whichever one is up. Trimming it off here once turned a picked
    // project into a bare /new — a new session right where you were.
    const line = expanded.text.trimStart();
    const msg = line.trimEnd();
    if (expanded.missing.length) {
      const gone = expanded.missing.map((n) => `#${n}`).join(', ');
      if (!msg || msg.startsWith('/')) {
        this.note(`paste ${gone} is gone (from an earlier run) — the line was kept; delete the chip and resend`);
        return;
      }
      this.note(`paste ${gone} is gone (from an earlier run) — sent without it`);
    }
    if (!msg) return;
    const session = this.sessions.active();
    // A new session is being built: refuse messages so they don't route to
    // the old session. The text stays in the input box — resend when ready.
    // Slash commands and exit still run (they belong to the window, not the session).
    if (this.opening && !msg.startsWith('/') && msg !== 'exit' && msg !== 'quit') {
      this.note('not sent — opening a new session');
      return;
    }
    // Locked elsewhere = read-only here: refuse BEFORE the box clears. Slash
    // commands still run — they are the window's, not the session's. The ONE
    // busy test is activeHold (sessions.ts): the spinner and this guard can
    // never disagree, so a send is refused up front, never after the fact.
    const held = activeHold(session);
    if (held && !msg.startsWith('/') && msg !== 'exit' && msg !== 'quit') {
      this.note(`not sent — a turn is running (${held.label})`);
      return;
    }
    accept();
    // Commands too: /help answers into the pane the splash covers.
    this.setSplash(false);
    if (msg === 'exit' || msg === 'quit') { this.quit(); return; }
    if (msg.startsWith('/')) {
      const menu = matches(line, this.argChoices);
      if (menu.rows.length) {
        const row = menu.rows[Math.min(highlighted, menu.rows.length - 1)];
        // Rows are either commands, or the highlighted command's choices.
        if (menu.command) await this.runCommand(menu.command.name, fillOf(row));
        else await this.runCommand(row.name);
        return;
      }
      // No menu: either an argument follows the command (`/ask hello`)
      // or nothing matched. parse() tells the two apart.
      const { command, args, error } = parse(msg);
      if (command) { await this.runCommand(command.name, args); return; }
      this.note(error ?? `unknown command ${msg}`);
      return;
    }
    // No session on screen: the words have no conversation to land in. Say
    // where to get one instead of dropping them silently.
    if (!session) { this.note('no session is open — /project starts one, /resume reopens an earlier one'); return; }
    // Addressed to the session on screen, and it keeps running there whether
    // or not you stay to watch. Typed while one runs, it waits its turn.
    this.sessions.say(session.id, msg);
  };

  // ── launch ────────────────────────────────────────────────────────────────

  /** The launch, as the same flow /new and /project run, so the window is
   *  ALREADY OPEN when anything goes wrong: a failure lands as words in the
   *  pane and the screens that fix it are a slash command away, never a stack
   *  trace before the app exists. */
  private booted = false;
  boot = async (): Promise<void> => {
    if (!this.opts.boot || this.booted) return;
    this.booted = true;
    const want = this.opts.boot;
    if (want.resumeId) { await this.openSession({ kind: 'open', id: want.resumeId }); return; }
    // One parallel ask, then one draw. The pane stays blank until both land:
    // whether a session opens (ghost) or the picker comes up depends on the
    // project count AND the setting, and drawing before knowing either is
    // a guess — the old guess (ghost first) flashed under the picker.
    let projects: ProjectInfo[];
    let skipPicker: boolean;
    try {
      const [rows, settings] = await Promise.all([
        this.api('GET', '/projects') as unknown as Promise<ProjectInfo[]>,
        this.readSettings(),
      ]);
      projects = rows;
      skipPicker = settings.boot_last_project === true;
    } catch (e) {
      // The request function already named the server and the failure; what
      // goes under it is the fix, and there are two: the server answered and
      // refused the key, or nothing answered at that address at all.
      this.note((e as Error).message);
      if ((e as { code?: string }).code === 'unauthorized') {
        this.note('fix the key under /server — a server box prints its key with `phantom-backend key`; a dev checkout gets it from ./scripts/setup.sh');
      } else {
        this.note('have a server? its address and key go under /server, then /project starts a session');
        this.note('need one? quit and run `phantom-cli setup-backend`');
      }
      return;
    }
    this.seeProjects(projects);
    // Nothing registered yet: go straight to adding one. An empty install has
    // to be able to start from here, not from curl.
    if (!projects.length) { this.startAddProject(); return; }
    if (projects.length === 1) { await this.openSession({ kind: 'new', projectId: projects[0].id }); return; }
    // boot_last_project (a server setting, on by default) skips the picker:
    // a new session in the project of the newest session you drove yourself.
    // The ghost goes up NOW — the decision is made — and the session-list
    // read runs behind it. Off, the picker comes up on the blank pane and
    // the ghost follows the pick.
    if (skipPicker) {
      this.setSplash(true);
      try {
        const ss = ((await this.api('GET', '/sessions')) as unknown as { sessions: SessionInfo[] }).sessions;
        const last = lastProjectId(projects, ss);
        if (last) { await this.openSession({ kind: 'new', projectId: last }); return; }
      } catch (e) { this.note(`could not reopen your last project: ${(e as Error).message}`); }
    }
    await this.openPicker('project');
  };

  // ── the end ───────────────────────────────────────────────────────────────

  /** Quitting stops every session, not just the one on screen: a turn still
   *  streaming somewhere else holds an open request, and node waits for it. */
  quit(): void {
    this.sessions.abortAll();
    this.voice.stop();
    this.opts.exit?.();
  }

  /** Every agent closed — each turn interrupted and waited out, so every
   *  turn-ended reaches the server. What index.tsx awaits after the screen
   *  is down. */
  closeAgents(): Promise<void> { return this.sessions.closeAll(); }

  /** The window is going away: the clocks, the boards' event streams and the
   *  sidecar all close with it. */
  close(): void {
    this.settingsFeed?.stop();
    this.voice.stop();
    if (this.overlayClock) { clearInterval(this.overlayClock); this.overlayClock = null; }
    if (this.taskClock) { clearInterval(this.taskClock); this.taskClock = null; }
    for (const b of this.boards.values()) b.close();
    this.boards.clear();
    for (const f of this.feeds.values()) f.stop();
    this.feeds.clear();
  }
}

export type { LoadedSession };
