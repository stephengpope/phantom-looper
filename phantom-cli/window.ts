// The window: every session open in this terminal, the boards behind them,
// and what is on screen. Outside React, like SessionStore and BoardStore and
// for the same reason — a turn keeps streaming in a session you are not
// looking at, and the Assistant can open, close and switch sessions while no
// render is happening. App.tsx is a view over this object.
//
// The rule that shapes it: anything with a caller that is not a React event
// lives here. Typing, scrolling and the two toggles that only a keypress
// moves stay in App.
import { hostname } from 'node:os';
import type { ModelMessage, Tool } from 'ai';
import { SessionStore, activeHold, type LoadedSession } from './sessions.js';
import { BoardStore, type Card, type Stream } from './board.js';
import { VoiceClient, sidecarEnv, codingKanbanTool, screenModeTools,
  type KanbanArgs, type ScreenModeHandler } from './voice.js';
import { Transcript, adoptServerCopy, syncTranscriptUp, type TranscriptHeader } from './session.js';
import { parseTranscript, sumUsageFromJsonl } from '../core/llm/transcript.js';
import { pinnedCfg, sessionPin, type ModelPin } from '../core/llm/agentConfig.js';
import { openSession as coreOpenSession } from '../core/session.js';
import { buildAgent, buildAssistantAgent, codingInstructions } from './agentFromConfig.js';
import { runTurn } from './agent.js';
import { messagesToParts, nextId, type Part } from './state.js';
import { kanbanOps } from './kanban.js';
import { quiet, type Api } from './request.js';
import { REMOTE_DEFAULTS, VOICE_BOOT_KEYS, ASSISTANT_MODEL_KEYS, isLocalKey,
  type ConfigKey, type ConfigValue } from './config.js';
import { localValues, setLocal } from './local.js';
import { makeSettings } from './settings.js';
import { lastWorkspaceId, type SessionInfo, type WorkspaceInfo } from './components/Launcher.js';
import type { TasksView } from './components/Tasks.js';
import type { Preset } from './components/Presets.js';
import type { NewWorkspaceRequest } from './components/NewWorkspace.js';
import { COMMANDS, matches, parse } from './commands.js';
import { WorkspaceDirectory, buildAssistantKit } from './assistantKit.js';
import type { SkillMeta } from '../core/skills/skills.js';
import type { SecretIndexEntry, GitFacts } from '../core/llm/prompts/coding/wiring.js';

/** What the window remembers about a workspace: the banner's display name and
 *  the prefix its cards are named with (`PHA` → `PHA-7`). `error` says why a
 *  lookup fell back to the id, so a bare id never passes for a name. */
export interface WsFacts { label: string; cardPrefix?: string; error?: string }

/** A session seated on the first frame. The real launch passes `boot` instead
 *  and the window opens EMPTY: it must come up whatever is wrong, because the
 *  screens that fix a dead token or a bad address are all inside it. */
export interface Initial {
  sessionId: string; branch: string; workspaceId: string;
  /** The workspace's display name for the banner; the id stands in when the
   *  lookup failed — it still identifies the workspace. */
  workspace?: string;
  /** The workspace's card number prefix (`PHA`). The toolbar shows it when
   *  no card is attached, so you always know which project you are in. */
  cardPrefix?: string;
  tools: Record<string, Tool>; resumed: ModelMessage[];
  card?: number | null;
  /** True when this is a supervisor session — a read-only record. */
  readonly?: boolean;
  /** The stored system prompt when resuming (transcript header). Absent — a
   *  new session, or an old transcript — a fresh stack is assembled. */
  instructions?: string;
  /** The skill index for a NEW session's prompt. Unused on resume: the frozen
   *  prompt wins. */
  skills?: SkillMeta[];
  /** The workspace's git facts for a NEW session's prompt. Unused on resume. */
  git?: GitFacts;
}

/** What opening resolves to. core's openSession turns each into the same
 *  create / restart / attach path. */
export type OpenTarget = { kind: 'new'; workspaceId: string } | { kind: 'open'; id: string }
  | { kind: 'duplicate'; id: string };

/** An ask standing in the Assistant's pane, and the promise its tool is
 *  parked on. */
export interface Approval { label: string; subject: string; resolve: (ok: boolean) => void }

/** Closing answers with facts; each door renders them where its user is
 *  looking (the pane for /close, the picker's notice line for [x]). */
export type CloseResult = { ok: true; closed: string; on_screen: string; opened_new: boolean }
  | { error: string };

/** Which screen has replaced the prompt. `null` is the prompt itself. */
export type Menu = null | 'settings' | 'keys' | 'secrets' | 'model' | 'server' | 'voice' | 'workspace'
  | 'resume' | 'addWorkspace' | 'workspaceSettings' | 'sessions' | 'tasks' | 'archived' | 'presets'
  | 'duplicateModel';

/** /resume's page size: what the picker fetches at open and appends per
 *  scroll-to-the-bottom. Comfortably more than a screenful, small enough that
 *  a list of thousands never rides one response. */
export const PICKER_PAGE = 30;

export interface WindowOptions {
  api: Api;
  /** GET a server ND-JSON stream as records — each BoardStore follows its
   *  workspace's `/events` through it. Absent (tests): boards load once. */
  stream?: Stream;
  /** Tools are per session, so every session that joins needs a fresh set.
   *  `plan` builds the plan-mode kit: the readonly preset on the mutating kits. */
  newTools: (sessionId: string, plan?: boolean, workspaceId?: string) => Promise<Record<string, Tool>>;
  configPath?: string;
  /** Settings as index.tsx read them a moment ago, for the FIRST agent build
   *  only. Not a cache: nothing reads it twice. */
  bootConfig?: Record<string, ConfigValue>;
  initial?: Initial;
  /** What launching wants: resume a named session, or find a workspace and
   *  start. A resume has history coming, so it never opens on the splash. */
  boot?: { resumeId?: string };
  makeAgent?: typeof buildAgent;
  makeTranscript?: (header: TranscriptHeader) => Transcript;
  run?: typeof runTurn;
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
  onSession?: (s: { id: string; branch: string; workspaceId: string }) => void;
  /** Ink's exit, so /exit and ctrl+c can end the process. */
  exit?: () => void;
  makeAssistantAgent?: typeof buildAssistantAgent;
  /** The Assistant's read-only workspace tools for one session. */
  newAssistantTools?: (sessionId: string) => Promise<Record<string, Tool>>;
  /** Width of the voice pane as a percent, when `sidebar_width` is not set. */
  sidebarPercent?: number;
  /** This window's session-lock id, so its own held sessions do not read
   *  "in use" on /resume. Empty in tests. */
  clientId?: string;
  /** How often the open /resume and /tasks lists refresh. Session state on
   *  screen follows the live feed, not this clock. Test seam. */
  pollMs?: number;
  /** How often the session's container is asked what is running while the
   *  window idles. Turn ends and opening /tasks refresh it too. Test seam. */
  taskPollMs?: number;
}

/** Each voice switch IS a setting: the toggle writes it, and the state holds
 *  across engine and TUI restarts. */
const SWITCH_KEY: Record<'mic' | 'speaker' | 'headphones' | 'wake', ConfigKey> = {
  mic: 'voice_mic_muted', speaker: 'voice_speaker_muted',
  headphones: 'voice_headphones', wake: 'voice_wake_word',
};

/** The banner at the top of a session: where you are, then the model line. */
function bannerParts(s: { workspace: string; branch: string },
  summary: { provider: string; model: string; reasoning: string }): Part[] {
  return [
    `${s.workspace} · ${s.branch}`,
    `${summary.provider}/${summary.model} · reasoning ${summary.reasoning}`,
  ].map((text) => ({ kind: 'note', id: nextId('note'), text }) as Part);
}

export class WindowStore {
  /** Every session open here, and the one turn each may run. */
  readonly sessions: SessionStore;
  /** The Assistant, over the Python sidecar. Constructed, never started: the
   *  window comes up with voice off unless a setting says otherwise. */
  readonly voice: VoiceClient;
  /** One board per workspace, shared by the /kanban view, the Assistant's
   *  board tool and every coding session's — so a tool edit repaints an open
   *  board with no extra wiring. */
  private readonly boards = new Map<string, BoardStore>();
  /** Display name and card prefix per workspace: one lookup each, ever. */
  private readonly wsNames = new Map<string, WsFacts>();

  /** The launch splash, where the conversation will be. Cleared by the first
   *  thing that wants the screen back. */
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

  /** The unsent text on the prompt, asked for at the moment of a switch so it
   *  can be parked on the session being left. App fills this in. */
  draftOnScreen: () => string = () => '';

  /** What the LEFT PANE is showing: the chat, the kanban board, or a card's
   *  editor. A card carries where esc goes BACK to, because that is the only
   *  thing that ever differed between a card opened from the chat and the same
   *  card opened from the board. One variable, one owner: the board used to
   *  keep a second copy of "a card is open" and every caller that was not a
   *  keypress had to work out which of the two to write. */
  view: 'chat' | 'board' | { card: number; back: 'chat' | 'board' } = 'chat';

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

  setView(v: 'chat' | 'board' | { card: number; back: 'chat' | 'board' }): void {
    this.view = v;
    if (v !== 'chat') this.splash = false;
    this.notify();
  }

  /** A card's editor, and where esc leaves it. Opening one from the board
   *  goes back to the columns; from anywhere else, back to the chat. */
  openCard(seq: number, back: 'chat' | 'board' = 'chat'): void { this.setView({ card: seq, back }); }

  /** esc out of a card's editor, to wherever it was opened from. */
  closeCard(): void { this.setView(typeof this.view === 'object' ? this.view.back : 'chat'); }

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

  constructor(private readonly opts: WindowOptions) {
    this.settings = makeSettings(opts.api);
    this.workspaces = new WorkspaceDirectory(opts.api);
    this.voice = (opts.makeVoice ?? (() => new VoiceClient(undefined, undefined, opts.run ?? runTurn)))();
    this.splash = opts.initial ? opts.initial.resumed.length === 0 : !opts.boot?.resumeId;
    this.voiceEnabled = Boolean(opts.bootConfig?.voice_enabled);
    this.sidebarWidth = Number(opts.bootConfig?.sidebar_width) || (opts.sidebarPercent ?? 20);
    if (opts.initial?.workspace) {
      this.wsNames.set(opts.initial.workspaceId, { label: opts.initial.workspace,
        ...(opts.initial.cardPrefix ? { cardPrefix: opts.initial.cardPrefix } : {}) });
    }
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

  /** Settings, read where they are used. Never held: a resolved object goes
   *  stale the moment anything writes through another door. */
  private readCfg = async (): Promise<Record<string, ConfigValue>> =>
    ({ ...await this.settings.read(), ...localValues(this.opts.configPath) });

  private get api(): Api { return this.opts.api; }

  // ── boards ────────────────────────────────────────────────────────────────

  boardFor(workspaceId: string): BoardStore {
    let b = this.boards.get(workspaceId);
    if (!b) {
      b = new BoardStore(this.api, workspaceId, this.opts.stream);
      b.follow();
      this.boards.set(workspaceId, b);
    }
    return b;
  }

  /** The coding agent's board handler, bound to the session's OWN workspace —
   *  not the one on screen: a turn keeps running while you switch away. */
  private codingKanbanHandler = (workspaceId: string) =>
    (args: KanbanArgs) => kanbanOps(this.boardFor(workspaceId), args);

  // ── plan mode, for both in-window agents ──────────────────────────────────

  /** getMode reads the SESSIONS TABLE, not this window's mirror: a session
   *  open in the background could answer from a copy the looper or another
   *  window has since changed. Having read the row it FOLLOWS it, so the
   *  answer and this window's kit converge. enterPlan is the agents' one-way
   *  on-switch; only the user's /plan comes back. Bound to a session id for
   *  the coding agent; unbound = the session on screen, for the Assistant. */
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
        if (e.readonly) return { ok: false, error: 'a supervisor record has no modes' };
        if (e.planMode) return { ok: false, error: 'already in plan mode' };
        await this.api('PATCH', `/sessions/${e.id}`, { plan_mode: true });
        await this.applyPlanMode(e.id, true);
        return { ok: true };
      },
    };
  }

  /** Flip a loaded session's plan mode: rebuild the kit (readonly preset on,
   *  full set off) and the agent over it, then move mode and tools together.
   *  /plan calls this after its PATCH lands; the feed calls it when the server
   *  says another window flipped it. A turn already streaming keeps the agent
   *  it started with. No-op while nothing changed; a supervisor record never
   *  flips. */
  applyPlanMode = async (id: string, on: boolean): Promise<void> => {
    const e = this.sessions.get(id);
    if (!e || e.readonly || e.planMode === on) return;
    const tools = await this.codingKit(id, on, e.workspaceId);
    // Plan mode changes the KIT, never the model: rebuilding through the
    // session's pin is what keeps a flip from quietly moving a conversation
    // onto whatever /model says now.
    const { agent, summary } = this.buildFor(
      tools, pinnedCfg(await this.readCfg(), e.pin), e.instructions, id);
    this.sessions.setPlanMode(id, on, tools, agent, summary);
  };

  /** The coding agent's whole kit for one session: the file tools the caller
   *  builds, plus the two the window owns. */
  private async codingKit(sessionId: string, plan: boolean, workspaceId: string): Promise<Record<string, Tool>> {
    return {
      ...await this.opts.newTools(sessionId, plan, workspaceId),
      ...codingKanbanTool(this.codingKanbanHandler(workspaceId)),
      ...screenModeTools(this.screenOps(sessionId)),
    };
  }

  private buildFor(tools: Record<string, Tool>, cfg: Record<string, ConfigValue>,
    instructions: string | undefined, noteInto: string) {
    const make = this.opts.makeAgent ?? buildAgent;
    return make(tools, cfg, instructions, (t) => this.sessions.note(noteInto, t));
  }

  // ── the session store, and the turn's two ends ────────────────────────────

  private newSessionStore(): SessionStore {
    // When a turn ends the whole local file goes to the server — SQL is the
    // record. Chained per session: two turns ending close together must land
    // in order, or a stale upload could overwrite the newer one. A failure is
    // noted ONCE per streak, so a server that cannot store transcripts is one
    // line, not one per turn.
    const chains = new Map<string, Promise<void>>();
    const failing = new Set<string>();
    const s: SessionStore = new SessionStore(this.opts.run ?? runTurn, (e) => {
      const prev = chains.get(e.id) ?? Promise.resolve();
      chains.set(e.id, prev.then(() => syncTranscriptUp(this.api, e.id, e.transcript.path)).then(
        (stamp) => { s.setStamp(e.id, stamp); if (failing.delete(e.id)) s.note(e.id, 'transcript sync recovered'); },
        (err) => {
          if (failing.has(e.id)) return;
          failing.add(e.id);
          s.note(e.id, `transcript sync failed (kept locally): ${(err as Error).message}`);
        },
      // The turn's lock is released once the record landed (or failed —
      // holding it helps nobody; the file is kept locally either way).
      ).finally(() => { void this.api('DELETE', `/sessions/${e.id}/lock`).catch(quiet(`release session ${e.id}`)); }));
      // The toolbar's task count follows every turn — a turn is when tasks
      // start and stop. Background: a failure goes to cli.log, not the pane.
      void this.onTurnEnded?.().catch(quiet('refresh tasks'));
    });
    // Lock per TURN: taken as a send starts, released above. Opening never
    // locks — reading is free. The lock response carries the transcript's
    // stamp: unchanged = memory is current; moved = another machine advanced
    // this session, so pull ONCE, reseat, then run.
    s.onTurnStart = async (id) => {
      const r = await this.api('POST', `/sessions/${id}/lock`, { label: hostname() }) as
        { transcript_updated_at?: string | null };
      await this.refreshIfMoved(id, r?.transcript_updated_at ?? null);
    };
    // This window's own turn, relayed as it runs, so any watcher sees it
    // stream exactly like a turn the server runs.
    s.relay = async (id, events) => { await this.api('POST', `/sessions/${id}/events`, { events }); };
    if (this.opts.initial) this.seat(s, this.opts.initial);
    return s;
  }

  /** Whatever wants to hear that a turn settled. The /tasks count hangs off
   *  it: a turn is when tasks start and stop. */
  onTurnEnded: (() => Promise<void>) | null = null;

  /** The seeded session, on the first frame. The prompt is assembled ONCE
   *  here and frozen into the transcript header, so this session keeps these
   *  instructions for life. */
  private seat(s: SessionStore, initial: Initial): void {
    const instructions = initial.instructions ?? codingInstructions(initial.skills ?? [], initial.git);
    const tools = { ...initial.tools, ...codingKanbanTool(this.codingKanbanHandler(initial.workspaceId)),
      ...screenModeTools(this.screenOps(initial.sessionId)) };
    const make = this.opts.makeAgent ?? buildAgent;
    const { agent, summary } = make(tools, this.opts.bootConfig ?? REMOTE_DEFAULTS, instructions,
      (t) => s.note(initial.sessionId, t));
    const transcript = (this.opts.makeTranscript ?? ((h: TranscriptHeader) => new Transcript(h)))({
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

  /** Compare the server's transcript stamp with what memory matches; when it
   *  moved, pull and reseat. The ONE reseat path: turn start, switch, and the
   *  feed. `server` is the stamp the caller already holds; null means don't
   *  look. Never caught here — a failure inside the feed's handler must reject
   *  into followStream so the link reconnects onto a fresh snapshot. */
  refreshIfMoved = async (id: string, server: string | null, keepScreen = false): Promise<void> => {
    const cur = this.sessions.get(id);
    if (!cur || cur.busy || !server || server === cur.syncStamp) return;
    const t = await this.api('GET', `/sessions/${id}/transcript`) as
      { data: string | null; updated_at?: string | null };
    // Same seating rule as open: a local file that is the server's text plus
    // unsaved steps is kept and shipped; the screen shows the fuller copy.
    const seated = adoptServerCopy(id, t.data);
    const parsed = parseTranscript(seated.text);
    if (seated.localKept) {
      void syncTranscriptUp(this.api, id).then((stamp) => this.sessions.setStamp(id, stamp),
        quiet(`upload unsaved steps for session ${id}`));
    }
    // keepScreen: the feed showed us this whole turn as it happened, so the
    // record brings the history and the stamp and the screen keeps what it
    // drew — richer than a transcript replay, and no repaint to jump through.
    this.sessions.reseat(id, parsed.messages, keepScreen ? null : [
      { kind: 'note', id: nextId('note'), text: 'refreshed — this session moved forward elsewhere' } as Part,
      ...messagesToParts(parsed.messages),
    ], t.updated_at ?? server, sumUsageFromJsonl(seated.text).output);
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

  /** Show that session's conversation in the pane, tail first. The unsent
   *  text goes with the session being left and comes back with it. */
  switchTo = (id: string): void => {
    const prev = this.sessions.active();
    if (prev) prev.draft = this.draftOnScreen();
    if (!this.sessions.activate(id)) return;
    this.splash = false;
    const e = this.sessions.get(id);
    if (e) this.opts.onSession?.({ id: e.id, branch: e.branch, workspaceId: e.workspaceId });
    this.watchTasks();
    this.notify();
    // Cheap staleness check in the background: pull only when the server's
    // stamp actually moved.
    if (e && !e.busy) {
      void (async () => {
        try {
          const row = await this.api('GET', `/sessions/${id}`) as { transcript_updated_at?: string | null };
          await this.refreshIfMoved(id, row?.transcript_updated_at ?? null);
        } catch (err) { quiet(`check session ${id} for changes`)(err); }
      })();
    }
  };

  /** tab and shift+tab: the next session in the ring. */
  cycle(dir: 1 | -1): void {
    const target = this.sessions.next(dir);
    if (!target) { this.note('this is the only session open — /new or /resume opens another'); return; }
    this.switchTo(target.id);
  }

  // ── workspaces ────────────────────────────────────────────────────────────

  /** The workspace LIST carries the same two facts per row: whoever reads it
   *  fills the cache, so a later open needs no lookup. */
  seedWsFacts(list: { id: string; name?: string; displayName?: string | null; cardPrefix?: string }[]): void {
    for (const w of list) {
      const label = w.displayName || w.name;
      if (label && !this.wsNames.has(w.id)) {
        this.wsNames.set(w.id, { label, ...(w.cardPrefix ? { cardPrefix: w.cardPrefix } : {}) });
      }
    }
  }

  /** The display name and card prefix for a workspace, one lookup ever. A
   *  failure answers with the id AND says why, so an id never passes for a
   *  workspace called that. */
  async wsFacts(id: string): Promise<WsFacts> {
    const hit = this.wsNames.get(id);
    if (hit) return hit;
    try {
      const w = await this.api('GET', `/workspaces/${id}`) as
        { name?: string; displayName?: string | null; cardPrefix?: string };
      const found = w.displayName || w.name;
      if (!found) throw new Error('the server sent no name for it');
      const facts: WsFacts = { label: found, ...(w.cardPrefix ? { cardPrefix: w.cardPrefix } : {}) };
      this.wsNames.set(id, facts);
      return facts;
    } catch (e) {
      return { label: id, error: `could not read workspace ${id}'s name: ${(e as Error).message}` };
    }
  }

  /** The name to say for a workspace id — the id itself when unknown, which
   *  is still an answer rather than a blank. */
  wsLabel(id: string): string { return this.wsNames.get(id)?.label ?? id; }

  /** What the toolbar calls the work in front of you: the card the session is
   *  building, named the way the board names it (`PHA-7`), and failing that
   *  the workspace's prefix alone (`PHA`) so the line always says which
   *  project you are in. Nothing at all when neither is known. */
  get cardMark(): string | undefined {
    const e = this.sessions.active();
    if (!e) return undefined;
    return e.card ?? this.wsNames.get(e.workspaceId)?.cardPrefix;
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
      const sessionId = target.kind === 'duplicate'
        ? ((await this.api('POST', `/sessions/${target.id}/duplicate`, {}) as { id: string }).id)
        : target.kind === 'open' ? target.id : undefined;
      const opened = await coreOpenSession({ call: this.api, label: hostname(),
        ...(sessionId ? { sessionId } : { workspaceId: (target as { workspaceId: string }).workspaceId }) });
      const row = opened.session as { id: string; branch: string; workspaceId: string;
        agent?: string | null; card?: number | null; planMode?: boolean;
        provider?: string | null; model?: string | null;
        skills?: SkillMeta[]; secrets?: SecretIndexEntry[]; agent_git_credentials?: boolean };
      // The server record IS the conversation — unless this machine holds
      // unsaved steps on top of it (a window that died mid-turn); then the
      // local file is the fuller copy, opens here, and goes up now.
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
          syncStamp = await syncTranscriptUp(this.api, row.id);
          seatNote = 'unsaved steps found on this machine — uploaded';
        } catch (e) {
          seatNote = `unsaved steps found on this machine — kept locally, upload failed: ${(e as Error).message}`;
        }
      }
      // The row's plan_mode seeds the mode AND picks the kit — the two must
      // never disagree, so they read the same fact.
      const planMode = row.planMode === true;
      const tools = await this.codingKit(row.id, planMode, row.workspaceId);
      // Same freeze rule as launch: the transcript's stored prompt wins; a
      // session without one gets a fresh stack, with the skill and secret
      // indexes the create response froze.
      const instructions = header?.system_prompt
        ?? codingInstructions(row.skills ?? [],
          row.agent_git_credentials === undefined ? undefined
            : { credentials: row.agent_git_credentials },
          row.secrets ?? []);
      // THE rule (core agentConfig): a session that has said anything runs on
      // its pin — the row's provider/model/endpoint, or, for rows written
      // before those columns, its transcript header's. Global settings reach a
      // session with nothing said yet and nothing else. The pin is kept on the
      // entry so every later rebuild (plan mode, /model) resolves the same way
      // instead of reading the global settings again.
      const pin = resumed.length > 0 ? sessionPin(row, header) : null;
      const modelCfg = pinnedCfg(await this.readCfg(), pin);
      const { agent, summary } = this.buildFor(tools, modelCfg, instructions, row.id);
      const transcript = (this.opts.makeTranscript ?? ((h: TranscriptHeader) => new Transcript(h)))({
        type: 'session', session_id: row.id, workspace: row.workspaceId, branch: row.branch,
        provider: summary.provider, model: summary.model,
        // The endpoint is part of what ran: it pins with the pair (016).
        ...(modelCfg.base_url ? { base_url: String(modelCfg.base_url) } : {}),
        created_at: new Date().toISOString(),
        system_prompt: instructions,
      });
      // An unpinned session's header model is PROVISIONAL: a duplicate's copy
      // arrives with the model fields stripped from its transcript, so line 1
      // on disk names what is in effect NOW (and /model keeps moving it until
      // the first new message). The first save pins whatever it then says.
      if (!pin) transcript.setModel({ provider: summary.provider, model: summary.model,
        base_url: modelCfg.base_url ? String(modelCfg.base_url) : null });
      // The card this session builds, named the way the board names it
      // (`PHA-7`), resolved ONCE here where both facts are in hand.
      const ws = await this.wsFacts(row.workspaceId);
      const card = row.card != null
        ? `${ws.cardPrefix ? `${ws.cardPrefix}-` : 'card '}${row.card}` : undefined;
      // Park the current session's draft before the new one takes over.
      const prev = this.sessions.active();
      if (prev) prev.draft = this.draftOnScreen();
      this.sessions.add({
        id: row.id, branch: row.branch, workspaceId: row.workspaceId,
        tools, agent, summary, transcript, instructions,
        history: resumed,
        syncStamp,
        pin,
        planMode,
        // The toolbar's lifetime output tokens: the seated file is the
        // record's working copy, so its usage lines are the exact sum —
        // including any unsaved local steps adoptServerCopy kept.
        totalTokens: sumUsageFromJsonl(seated.text).output,
        ...(card ? { card } : {}),
        ...(row.agent === 'supervisor' ? { readonly: true } : {}),
        done: [
          ...bannerParts({ workspace: ws.label, branch: row.branch }, summary),
          ...(ws.error ? [{ kind: 'note', id: nextId('note'), text: ws.error } as Part] : []),
          ...(row.agent === 'supervisor'
            ? [{ kind: 'note', id: nextId('note'),
                text: `the supervisor's record${row.card != null ? ` · card ${row.card}` : ''} — read-only` } as Part]
            : []),
          ...(seatNote ? [{ kind: 'note', id: nextId('note'), text: seatNote } as Part] : []),
          ...messagesToParts(resumed),
        ],
      });
      // An empty conversation opens on the splash, exactly as boot's does.
      this.splash = resumed.length === 0;
      this.opening = false;
      this.watchTasks();
      this.notify();
      this.opts.onSession?.({ id: row.id, branch: row.branch, workspaceId: row.workspaceId });
      return true;
    } catch (e) {
      const what = target.kind === 'new'
        ? `could not start a session in ${this.wsLabel(target.workspaceId)}`
        : target.kind === 'duplicate' ? `could not duplicate session ${target.id}`
          : `could not open session ${target.id}`;
      this.opening = false;
      this.note(`${what}: ${(e as Error).message}`);
      return false;
    }
  };

  /** [d] on a session row: duplicate it. Presets get a say first — the copy
   *  is born unpinned, so this is the one moment "this conversation, another
   *  model" is possible: picking one applies it exactly as /presets does, and
   *  the copy floats on it until its first new message pins it. No presets,
   *  no question.
   *
   *  The list's own lock marker is the gate: a row the server said is held
   *  is refused HERE, on the picker — no menu close, no preset question, no
   *  dead round-trip. The marker can be a poll behind, so this is only the
   *  shortcut: a stale "held" self-heals on the next refresh (kicked off
   *  right away), a stale "free" meets the server's 409 as before. */
  startDuplicate = async (id: string): Promise<void> => {
    const row = this.picker?.sessions.find((s) => s.id === id);
    if (row?.locked) {
      // The server's own words, whichever side the hold is on — the marker
      // can be a poll behind, so this is only the shortcut: a stale "held"
      // self-heals on the refresh kicked here, a stale "free" meets the
      // server's 409 saying the same.
      this.pickerNotice = 'session is in use — stop it first, or wait for it to complete';
      this.notify();
      void this.refreshPicker().catch(quiet('refresh the session list'));
      return;
    }
    this.pickerNotice = undefined;   // the gate passed — no refusal to show
    this.setMenu(null);
    try {
      const presets = await this.api('GET', '/presets') as Preset[];
      if (!presets.length) { await this.openSession({ kind: 'duplicate', id }); return; }
      const cfg = await this.readCfg();
      this.duplicating = { id, presets,
        current: { provider: String(cfg.provider ?? ''), model: String(cfg.model ?? '') } };
      this.setMenu('duplicateModel');
    } catch (e) {
      this.note(`could not duplicate session ${id}: ${(e as Error).message}`);
    }
  };

  /** The duplicate prompt's answer: a preset id (apply it as /presets does,
   *  then copy) or null (copy on the current settings). The preset lands
   *  BEFORE the open, so the copy's fresh header names it. */
  finishDuplicate = async (presetId: string | null): Promise<void> => {
    const d = this.duplicating;
    this.duplicating = null;
    this.setMenu(null);
    if (!d) return;
    try {
      if (presetId) {
        const p = d.presets.find((x) => x.id === presetId);
        if (!p) throw new Error('that preset is gone');
        const patch: Record<string, ConfigValue> = {};
        for (const [k, v] of Object.entries(p.values)) patch[k] = v as ConfigValue;
        if (Object.keys(patch).length) await makeSettings(this.api).patch(patch);
        this.settingChanged('provider' as ConfigKey);
      }
      await this.openSession({ kind: 'duplicate', id: d.id });
    } catch (e) {
      this.note(`could not duplicate session ${d.id}: ${(e as Error).message}`);
    }
  };

  /** esc on the duplicate prompt: nothing happens, no copy is made. */
  cancelDuplicate = (): void => { this.duplicating = null; this.setMenu(null); };

  /** THE close: a session leaves local memory. Nothing on the server changes,
   *  so opening it again gets it back exactly as it was. Every door ([x] on
   *  /resume, /close, the Assistant's session_close) comes through here.
   *  Refused while a turn runs there. Closing the one on screen hands the
   *  screen to whatever you spoke to most recently; closing the LAST one opens
   *  a fresh session in the same workspace, because close means "done with
   *  this", never "leave me looking at nothing". */
  closeSession = async (id?: string): Promise<CloseResult> => {
    const target = id ?? this.sessions.activeId;
    if (!target) return { error: 'no session is open — nothing to close' };
    const e = this.sessions.get(target);
    if (!e) return { error: `session ${target} is not open in this window — nothing to close` };
    const { workspaceId } = e;
    const wasOnScreen = this.sessions.activeId === target;
    if (!this.sessions.close(target)) return { error: `a turn is running in ${target} — stop it first` };
    let opened_new = false;
    if (wasOnScreen) {
      const next = this.sessions.list()[0];
      if (next) this.switchTo(next.id);
      else opened_new = await this.openSession({ kind: 'new', workspaceId });
      // Both of those restart the count's clock; a failed open leaves no
      // session on screen, and this is what clears the toolbar's count.
      if (!this.sessions.activeId) this.watchTasks();
    }
    return { ok: true, closed: target, on_screen: this.sessions.activeId, opened_new };
  };

  // ── the screens ───────────────────────────────────────────────────────────
  // Which screen has replaced the prompt, and the data behind the three that
  // do not fetch for themselves. They are fed rather than self-fetching for
  // one reason: every one of them opens fetch-FIRST, so a server that cannot
  // answer leaves you on the chat with a note instead of on an empty screen.
  // Two of them also need facts only this window has — which sessions are open
  // here, which is mid-turn, this window's lock id.

  menu: Menu = null;
  /** The workspace whose settings are showing (`e` on /workspace). Held apart
   *  from `menu` so closing that screen lands back on the list it came from. */
  editing: WorkspaceInfo | null = null;
  /** A rejected "add a workspace" stays on the form with the server's words. */
  addError: string | undefined;
  /** The workspace rows the switcher names its sessions with, fetched the
   *  first time a screen needs them and never at launch. */
  workspaceRows: WorkspaceInfo[] = [];
  /** The names the Assistant speaks with — the same cache, shared. */
  readonly workspaces: WorkspaceDirectory;

  picker: { workspaces: WorkspaceInfo[]; sessions: SessionInfo[]; total: number; end: boolean } | null = null;
  pickerNotice: string | undefined;
  /** A duplicate waiting on its one question — which model the copy runs on.
   *  Held apart from `menu` so esc simply drops it. */
  duplicating: { id: string; presets: Preset[]; current: { provider: string; model: string } } | null = null;
  /** [s] on /resume: the looper's supervisor seats in the list or not. A fetch
   *  parameter, not a filter — the server decides what the list is. */
  showSupervised = false;
  private trashArmed: string | null = null;
  private morePickerInFlight = false;

  tasks: TasksView | null = null;
  tasksNotice: string | undefined;
  /** The toolbar's count. Null only before the first read lands. */
  taskCount: number | null = null;
  private killArmed: string | null = null;

  archived: Card[] = [];
  archivedNotice: string | undefined;
  /** The whole archive's size (the server's count); `archived` is what is
   *  loaded, and the screen counts what is below against this. */
  archivedTotal: number | undefined;
  private archivedEnd = false;
  private moreArchivedInFlight = false;

  /** The open screen's re-read clock, and the task count's own. Cleared and
   *  restarted by setMenu and by a change of session; both unref'd so neither
   *  holds the process open. */
  private menuClock: ReturnType<typeof setInterval> | null = null;
  private taskClock: ReturnType<typeof setInterval> | null = null;

  private get pollMs(): number { return this.opts.pollMs ?? 10_000; }

  /** Open a screen, or close whatever is open (`null`). /resume and /tasks are
   *  status lists — rows spin, locks appear and lapse, turns end on other
   *  machines — so while one is open it re-reads on `pollMs`. The refresh
   *  swaps rows in place: the cursor, the notice line and an armed
   *  confirmation all stay put. A failed tick is silent, because an
   *  unreachable server must not nag every ten seconds while old rows serve. */
  setMenu(m: Menu): void {
    this.menu = m;
    if (m !== null) this.splash = false;
    if (this.menuClock) { clearInterval(this.menuClock); this.menuClock = null; }
    const tick = m === 'resume' ? () => { void this.refreshPicker().catch(quiet('refresh the session list')); }
      : m === 'tasks' ? () => { void this.refreshTasks().catch(quiet('refresh tasks')); }
        : null;
    if (tick) {
      this.menuClock = setInterval(tick, this.pollMs);
      this.menuClock.unref?.();
    }
    this.notify();
  }

  // ── /resume and /workspace ────────────────────────────────────────────────

  /** The list's FILTERS are the server's (`typed`, `supervisor`): a page is a
   *  page on screen, and `total` is the count for exactly these filters. */
  private listQuery(): string {
    return `typed=true${this.showSupervised ? '' : '&supervisor=false'}`;
  }

  /** The one addition only this window can make: sessions open HERE that the
   *  server would leave out (nothing typed yet). Merged in, counted in — the
   *  switcher must never hide an open session. */
  private withOpenHere(rows: SessionInfo[], total: number) {
    const seen = new Set(rows.map((s) => s.id));
    const extras: SessionInfo[] = this.sessions.list()
      .filter((e) => !seen.has(e.id) && !e.readonly)
      .map((e) => ({
        id: e.id, workspaceId: e.workspaceId, branch: e.branch, status: 'active', agent: null,
        model: e.summary.model, tokensOutput: e.totalTokens || null,
        // Nothing typed = no activity: it sorts LAST, never ahead of real work.
        lastUsedAt: new Date(e.lastMessageAt || 0).toISOString(), locked: false, lastUserMessage: null,
      }));
    return { sessions: [...rows, ...extras], total: total + extras.length };
  }

  /** THE picker fetch — the only place the two lists are read. Throws on
   *  failure so each caller decides what that means: opening says so and stays
   *  put; a background refresh keeps quiet and keeps the list it has. A
   *  refresh re-reads however many rows are loaded, so what is on screen stays
   *  live however deep you have scrolled. A short page = the end. */
  refreshPicker = async (): Promise<void> => {
    const want = Math.max(this.picker?.sessions.length ?? 0, PICKER_PAGE);
    const [ws, got] = await Promise.all([
      this.api('GET', '/workspaces'),
      this.api('GET', `/sessions?${this.listQuery()}&limit=${want}`),
    ]);
    const { sessions: ss, total } = got as { sessions: SessionInfo[]; total: number };
    this.picker = { workspaces: ws as WorkspaceInfo[], ...this.withOpenHere(ss, total), end: ss.length < want };
    this.seeWorkspaces(ws as WorkspaceInfo[]);
    this.notify();
  };

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
        + `&before=${encodeURIComponent(tail.lastUsedAt)}&before_id=${tail.id}`) as
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
  openPicker = async (which: 'workspace' | 'resume'): Promise<void> => {
    try {
      await this.refreshPicker();
      this.pickerNotice = undefined;
      this.trashArmed = null;
      this.setMenu(which);
    } catch (e) {
      this.note(`could not list ${which === 'resume' ? 'sessions' : 'workspaces'}: ${(e as Error).message}`);
    }
  };

  /** [s] on /resume: flip the filter and re-read. */
  toggleSupervised(): void {
    this.showSupervised = !this.showSupervised;
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

  /** [t] on /resume: the session leaves the server for good — row, transcript,
   *  files; only its pushed branch on origin survives. Unpushed work refuses
   *  once and arms; [c] confirms. */
  trashSession = async (id: string): Promise<void> => {
    if (this.sessions.has(id)) { this.pickerNotice = 'that session is open in this window'; this.notify(); return; }
    const force = this.trashArmed === id;
    try {
      await this.api('DELETE', `/sessions/${id}?purge=true${force ? '&force=true' : ''}`);
      this.trashArmed = null;
      this.pickerNotice = undefined;
      // The trash landed; a failed re-read must not report "could not trash".
      await this.refreshPicker().catch(quiet('refresh the session list'));
    } catch (e) {
      const m = (e as Error).message;
      const code = (e as { code?: string }).code ?? '';
      if (code === 'unpushed_work' || m.includes('unpushed_work')) {
        this.trashArmed = id;
        this.pickerNotice = 'unpushed work — [c] to confirm discard';
      } else if (code === 'session_locked' || m.includes('session_locked')) {
        this.pickerNotice = 'in use elsewhere — a held session cannot be trashed';
      } else this.pickerNotice = `could not trash session ${id}: ${m}`;
    }
    this.notify();
  };

  /** ctrl+n: the sessions open in this window. It shows FIRST and fills the
   *  workspace names in behind — the rows read fine as ids until they land. */
  openSwitcher(): void {
    this.setMenu('sessions');
    if (this.workspaceRows.length) return;
    void (async () => {
      try { this.seeWorkspaces(await this.api('GET', '/workspaces') as unknown as WorkspaceInfo[]); this.notify(); }
      catch (e) { this.note(`could not list workspaces: ${(e as Error).message}`); }
    })();
  }

  /** One workspace list, three consumers: the switcher's rows, the banner's
   *  name cache, and the names the Assistant speaks with. */
  private seeWorkspaces(rows: WorkspaceInfo[]): void {
    this.workspaceRows = rows;
    this.seedWsFacts(rows);
    this.workspaces.offer(rows);
    this.notify();
  }

  /** `e` on a /workspace row: that workspace's settings, on their own screen,
   *  remembering the list to come back to. */
  editWorkspace(id: string): void {
    const w = this.picker?.workspaces.find((x) => x.id === id);
    if (!w) return;
    this.editing = w;
    this.setMenu('workspaceSettings');
  }

  /** Back to the list it was opened from, refreshed — a rename there has to
   *  show up here. */
  closeWorkspaceSettings = async (): Promise<void> => {
    this.editing = null;
    await this.openPicker('workspace');
  };

  /** The add row, with any previous complaint cleared. */
  startAddWorkspace(): void { this.addError = undefined; this.setMenu('addWorkspace'); }

  /** The add form's submit. Adding a workspace is only useful if you then work
   *  in it, so it opens a session there; the confirmation goes AFTER that
   *  switch, into the session you land in, because noting it first writes it
   *  to the session you are leaving where the switch wipes it off unread. A
   *  rejected POST stays on the form with the server's own words, which
   *  distinguish already_exists from a token that cannot create. */
  addWorkspace = async (req: NewWorkspaceRequest): Promise<void> => {
    // Cleared before the call so a second failure with the SAME message is
    // still a change of the error the form sees.
    this.addError = undefined;
    this.notify();
    try {
      const w = await this.api('POST', '/workspaces', req) as { id: string; owner: string; name: string };
      this.setMenu(null);
      await this.openSession({ kind: 'new', workspaceId: w.id });
      this.note(`workspace ${w.owner}/${w.name} added`);
    } catch (e) {
      this.addError = (e as Error).message.replace(/^POST \/workspaces: /, '');
      this.setMenu('addWorkspace');
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
      this.killArmed = null;
      this.setMenu('tasks');
    } catch (e) { this.note(`could not list tasks: ${(e as Error).message}`); }
  };

  /** [k] arms the kill, [c] confirms (TERM, a second, then KILL — the whole
   *  tree). Armed per sid. */
  killTask = async (sid: string, command: string): Promise<void> => {
    const id = this.sessions.activeId;
    if (!id) return;
    if (this.killArmed !== sid) {
      this.killArmed = sid;
      this.tasksNotice = `kill "${command}"? — [c] to confirm`;
      this.notify();
      return;
    }
    this.killArmed = null;
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

  /** The workspace's archived cards, fetched for the screen alone: the board
   *  GET never carries the archive, because the board does not render it and
   *  the archive grows forever while the board stays small. Pages like
   *  /resume. Shared with the board's [v]. */
  openArchived = async (workspaceId: string): Promise<void> => {
    try {
      const d = await this.api('GET',
        `/workspaces/${workspaceId}/cards?archived=only&limit=${PICKER_PAGE}`) as { cards: Card[]; total?: number };
      this.archivedEnd = d.cards.length < PICKER_PAGE;
      this.archived = d.cards;
      this.archivedTotal = d.total;
      this.archivedNotice = undefined;
      this.setMenu('archived');
    } catch (e) { this.note(`could not list archived cards: ${(e as Error).message}`); }
  };

  /** The next page, appended in place — morePicker's shape. */
  moreArchived = async (workspaceId: string): Promise<void> => {
    const tail = this.archived[this.archived.length - 1];
    if (this.archivedEnd || !tail || this.moreArchivedInFlight) return;
    this.moreArchivedInFlight = true;
    try {
      const d = await this.api('GET', `/workspaces/${workspaceId}/cards?archived=only&limit=${PICKER_PAGE}`
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
  restoreCard = async (workspaceId: string, card: Card): Promise<void> => {
    try {
      await this.api('PATCH', `/workspaces/${workspaceId}/cards/${card.id}`, { archived: false });
      this.archived = this.archived.filter((x) => x.id !== card.id);
      this.archivedNotice = `restored ${card.seq}-${card.title} → ${card.status.replace(/_/g, ' ')}`;
      void this.boardFor(workspaceId).load();   // the card is back on the board
    } catch (e) { this.archivedNotice = `restore failed: ${(e as Error).message}`; }
    this.notify();
  };

  /** [enter] on /archived: the solo editor renders from the board store, which
   *  never holds archived cards on its own — seat this one first. */
  openArchivedCard = (workspaceId: string, card: Card): void => {
    this.boardFor(workspaceId).adoptCard(card);
    this.setMenu(null);
    // esc from here is the chat: the archive screen it came from is a menu,
    // and going "back" to a board the user never opened would be a surprise.
    this.openCard(card.seq, 'chat');
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
    return { api: this.api, clientId: this.opts.clientId ?? '',
      workspaces: this.workspaces,
      newAssistantTools: this.opts.newAssistantTools ?? (async () => ({})) };
  }

  /** Voice follows the setting: on at launch when enabled, stopped with the
   *  window. READ AT SPAWN — the sidecar takes its Deepgram key from the
   *  environment it is started with, so reading it here (not at app boot) is
   *  what lets you save the key, turn the Assistant on, and have it work the
   *  first time. A bad agent trio throws at build; say so rather than dying in
   *  a floating promise. */
  startVoice(): void {
    void (async () => {
      const make = this.opts.makeAssistantAgent ?? buildAssistantAgent;
      let built;
      let cfg: Record<string, ConfigValue>;
      try {
        cfg = await this.readCfg();
        built = make(await buildAssistantKit(this, this.assistantDeps), cfg);
      } catch (e) { this.note(`assistant not started: ${(e as Error).message}`); return; }
      this.voice.setAgent(built.agent, built.summary);
      void this.voice.start(sidecarEnv(cfg));
    })();
  }

  /** The read tools follow the session on screen: switching rebuilds the kit
   *  in place, same conversation, the new session's files. */
  async rebuildAssistant(): Promise<void> {
    if (!this.voice.running) return;
    const make = this.opts.makeAssistantAgent ?? buildAssistantAgent;
    try {
      const cfg = await this.readCfg();
      const kit = await buildAssistantKit(this, this.assistantDeps);
      this.voice.setAgent(make(kit, cfg).agent);
    } catch (e) { this.note(`assistant not rebuilt for this session: ${(e as Error).message}`); }
  }

  /** Launch: the chrome's two values and the voice decision, from one read. */
  async readChrome(): Promise<void> {
    try {
      const c = await this.readCfg();
      this.voiceEnabled = Boolean(c.voice_enabled);
      this.sidebarWidth = Number(c.sidebar_width) || (this.opts.sidebarPercent ?? 20);
      this.notify();
      if (c.voice_enabled) this.startVoice();
    } catch { /* index.tsx already refused to start without the server */ }
  }

  /** A setting changed. Everything that consumes one READS IT AGAIN here —
   *  rebuilding an agent, restarting the sidecar, pushing a live switch.
   *  Nothing is recomputed from a copy taken earlier, which is what used to
   *  leave the Assistant running on the settings it was born with. */
  settingChanged = (key?: ConfigKey): void => {
    void (async () => {
      let cfg: Record<string, ConfigValue>;
      try { cfg = await this.readCfg(); }
      catch (e) { this.note(`could not read settings: ${(e as Error).message}`); return; }
      this.voiceEnabled = Boolean(cfg.voice_enabled);
      this.sidebarWidth = Number(cfg.sidebar_width) || (this.opts.sidebarPercent ?? 20);

      const make = this.opts.makeAgent ?? buildAgent;
      const session = this.sessions.active();
      if (session) {
        const before = session.summary;
        const next = make(session.tools, cfg, session.instructions).summary;
        if (next.provider !== before.provider || next.model !== before.model) {
          if (session.lastMessageAt === 0) {
            // Unpinned: the switch must reach the header, whose model the
            // first save pins — the event alone would leave the OLD pick
            // frozen into line 1.
            session.transcript.setModel({ provider: next.provider, model: next.model,
              base_url: cfg.base_url ? String(cfg.base_url) : null });
            session.transcript.appendEvent({ type: 'model', provider: next.provider, model: next.model,
              at: new Date().toISOString() });
            this.note(`model → ${next.provider}/${next.model}`);
          }
        }
      }
      this.sessions.rebuildAgents((tools, instructions, id) => make(tools, cfg, instructions,
        (t) => { if (id) this.sessions.note(id, t); }));

      // The Assistant follows its settings: on/off starts and stops it; an
      // audio value (the Deepgram key, the devices) restarts the sidecar,
      // which reads them again as it spawns; a model value rebuilds the brain
      // in place — the history stays, the next turn uses the new model; the
      // spoken voice, the mutes, headphones and the wake word are pushed live.
      const running = this.voice.running;
      if (key === 'voice_enabled') {
        if (cfg.voice_enabled) this.startVoice(); else this.voice.stop();
        this.sidebar = null;
      } else if (running && key && VOICE_BOOT_KEYS.includes(key)) {
        this.startVoice();
      } else if (running && key && ASSISTANT_MODEL_KEYS.includes(key)) {
        await this.rebuildAssistant();
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
      }
      this.notify();
    })();
  };

  /** The one voice-switch toggle — /mic /speaker /headphones /wake, ctrl+r and
   *  ctrl+l, and a click on either of the pane's switch rows. Every switch IS
   *  a setting: the toggle writes it and goes through settingChanged, the same
   *  path the /voice screen takes, which is what keeps the screen and the
   *  toggle from diverging. The state holds across engine and TUI restarts. */
  toggleDevice = (which: 'mic' | 'speaker' | 'headphones' | 'wake'): void => {
    if (!this.voice.running) { this.note('voice is off — /voice to turn it on'); return; }
    const key = SWITCH_KEY[which];
    void (async () => {
      // Read the switch, flip it, write it, then let settingChanged read
      // everything again. A toggle is a read-modify-write, so it reads.
      let cfg: Record<string, ConfigValue>;
      try { cfg = await this.readCfg(); }
      catch (e) { this.note(`could not read settings: ${(e as Error).message}`); return; }
      const now = !cfg[key];
      // Where a switch is saved follows where the setting lives: the mutes and
      // the headphones switch are facts about this machine, the wake word is not.
      if (isLocalKey(key)) {
        const err = setLocal(key, now, this.opts.configPath);
        if (err) { this.note(err); return; }
      } else {
        try { await this.settings.write(key, now); }
        catch (e) { this.note(`could not save ${key}: ${(e as Error).message}`); return; }
      }
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
      case 'new':
        // No session yet = no workspace to mean "here": the picker chooses.
        // openSession clears the pane and puts the splash up before the
        // network calls run.
        if (session) await this.openSession({ kind: 'new', workspaceId: session.workspaceId });
        else await this.openPicker('workspace');
        return;
      case 'resume': await this.openPicker('resume'); return;
      case 'close': {
        const r = await this.closeSession();
        if ('error' in r) {
          this.note(r.error.includes('a turn is running')
            ? 'a turn is running here — esc stops it, then /close' : r.error);
        }
        return;
      }
      case 'workspace': await this.openPicker('workspace'); return;
      case 'rename': {
        if (!session) { this.note('no session is open — nothing to rename'); return; }
        try {
          await this.api('PATCH', `/sessions/${session.id}`, { name: args || null });
          this.note(args ? `renamed: ${args}` : 'name cleared — auto-titles are back on');
        } catch (e) { this.note(`could not rename session ${session.id}: ${(e as Error).message}`); }
        return;
      }
      case 'kanban':
        if (!session) { this.note('no session is open — the board belongs to a workspace; /workspace starts a session in one'); return; }
        this.setView('board');
        return;
      case 'archived':
        if (!session) { this.note('no session is open — archived cards belong to a workspace; /workspace starts a session in one'); return; }
        await this.openArchived(session.workspaceId);
        return;
      case 'tasks': await this.openTasks(); return;
      case 'plan': {
        // The server row first (the record every window reads), then this
        // window's kit. A failed rebuild reports it; the next feed snapshot
        // reads the saved mode again.
        if (!session) { this.note('no session is open — nothing to switch'); return; }
        if (session.readonly) { this.note("this is the supervisor's record — read-only"); return; }
        const on = !session.planMode;
        try {
          await this.api('PATCH', `/sessions/${session.id}`, { plan_mode: on });
          await this.applyPlanMode(session.id, on);
        } catch (e) { this.note(`could not switch plan mode ${on ? 'on' : 'off'}: ${(e as Error).message}`); }
        return;
      }
      case 'auto-push':
        if (!session) { this.note('no session is open — nothing to push'); return; }
        // Detached: a push can run for minutes and the prompt never locks.
        void this.runAutoPush(session.id);
        return;
      case 'auto-pull':
        if (!session) { this.note('no session is open — nothing to pull into'); return; }
        void this.runAutoPull(session.id);
        return;
      case 'settings': this.setMenu('settings'); return;
      case 'keys': this.setMenu('keys'); return;
      case 'secrets': this.setMenu('secrets'); return;
      case 'model': this.setMenu('model'); return;
      case 'presets': this.setMenu('presets'); return;
      case 'server': this.setMenu('server'); return;
      case 'voice':
        this.setMenu('voice');
        // The mic and speaker pickers want device names; with voice off, ask.
        void this.voice.refreshDevices();
        return;
      case 'mic': this.toggleDevice('mic'); return;
      case 'speaker': this.toggleDevice('speaker'); return;
      case 'headphones': this.toggleDevice('headphones'); return;
      case 'wake': this.toggleDevice('wake'); return;
      case 'assistant':
        if (!args) { this.note('/assistant <what to tell the Assistant>'); return; }
        if (!this.voice.say(args)) this.note('voice is off — /voice to turn it on');
        else if (this.sidebar === false) { this.sidebar = null; this.notify(); }
        return;
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
    const msg = text.trim();
    if (!msg) return;
    const session = this.sessions.active();
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
      const m = matches(msg);
      if (m.length) { await this.runCommand(m[Math.min(highlighted, m.length - 1)].name); return; }
      // No menu: either an argument follows the command (`/assistant hello`)
      // or nothing matched. parse() tells the two apart.
      const { command, args, error } = parse(msg);
      if (command) { await this.runCommand(command.name, args); return; }
      this.note(error ?? `unknown command ${msg}`);
      return;
    }
    // No session on screen: the words have no conversation to land in. Say
    // where to get one instead of dropping them silently.
    if (!session) { this.note('no session is open — /workspace starts one, /resume reopens an earlier one'); return; }
    // A supervisor session is the looper's record — read it, never chat into it.
    if (session.readonly) { this.note("this is the supervisor's record — read-only"); return; }
    // Addressed to the session on screen, and it keeps running there whether
    // or not you stay to watch. Typed while one runs, it waits its turn.
    this.sessions.say(session.id, msg);
  };

  // ── launch ────────────────────────────────────────────────────────────────

  /** The launch, as the same flow /new and /workspace run, so the window is
   *  ALREADY OPEN when anything goes wrong: a failure lands as words in the
   *  pane and the screens that fix it are a slash command away, never a stack
   *  trace before the app exists. */
  private booted = false;
  boot = async (): Promise<void> => {
    if (!this.opts.boot || this.booted) return;
    this.booted = true;
    const want = this.opts.boot;
    if (want.resumeId) { await this.openSession({ kind: 'open', id: want.resumeId }); return; }
    let ws: WorkspaceInfo[];
    try { ws = await this.api('GET', '/workspaces') as unknown as WorkspaceInfo[]; }
    catch (e) {
      // The request function already named the server and the failure; what
      // goes under it is the fix, and there are two: the server answered and
      // refused the key, or nothing answered at that address at all.
      this.note((e as Error).message);
      if ((e as { code?: string }).code === 'unauthorized') {
        this.note('fix the key under /server — a server box prints its key with `phantom-backend key`; a dev checkout gets it from ./scripts/setup.sh');
      } else {
        this.note('have a server? its address and key go under /server, then /workspace starts a session');
        this.note('need one? quit and run `phantom-cli setup-backend`');
      }
      return;
    }
    this.seeWorkspaces(ws);
    // Nothing registered yet: go straight to adding one. An empty install has
    // to be able to start from here, not from curl.
    if (!ws.length) { this.setMenu('addWorkspace'); return; }
    if (ws.length === 1) { await this.openSession({ kind: 'new', workspaceId: ws[0].id }); return; }
    // boot_last_workspace (a server setting, off by default) skips the picker:
    // a new session in the workspace of the newest session you drove yourself.
    try {
      if ((await this.readCfg()).boot_last_workspace === true) {
        const ss = ((await this.api('GET', '/sessions')) as unknown as { sessions: SessionInfo[] }).sessions;
        const last = lastWorkspaceId(ws, ss);
        if (last) { await this.openSession({ kind: 'new', workspaceId: last }); return; }
      }
    } catch (e) { this.note(`could not reopen your last workspace: ${(e as Error).message}`); }
    await this.openPicker('workspace');
  };

  // ── the end ───────────────────────────────────────────────────────────────

  /** Quitting stops every session, not just the one on screen: a turn still
   *  streaming somewhere else holds an open request, and node waits for it. */
  quit(): void {
    this.sessions.abortAll();
    this.voice.stop();
    this.opts.exit?.();
  }

  /** The window is going away: the clocks, the boards' event streams and the
   *  sidecar all close with it. */
  close(): void {
    this.voice.stop();
    if (this.menuClock) { clearInterval(this.menuClock); this.menuClock = null; }
    if (this.taskClock) { clearInterval(this.taskClock); this.taskClock = null; }
    for (const b of this.boards.values()) b.close();
    this.boards.clear();
  }
}

export type { LoadedSession };
