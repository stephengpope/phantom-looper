// What you see when the TUI starts with nothing to attach to. Sessions first,
// because a session is what you actually resume — it carries the branch and the
// conversation. Workspaces are the layer below, for starting something new.
//
// The boot-time shortcut past this screen is `boot_last_workspace` (a server
// setting, off by default): the sessions list already records where you were,
// so the pick comes off the newest session the user drove — never a pinned
// workspace id, which goes stale the moment you switch.
import { SelectList, type Choice } from './SelectList.js';
import { Screen, type FooterKey } from './Screen.js';
import { tableChoices, type TableRow } from './table.js';

export interface WorkspaceInfo {
  id: string; owner: string; name: string; displayName?: string | null;
  /** The resolved card number prefix ("PHA") — the server's, never derived here. */
  cardPrefix?: string;
}
export interface SessionInfo {
  id: string; workspaceId: string; branch: string; status: string; lastUsedAt: string;
  /** Someone holds this session right now (server-computed, no clock math). */
  locked?: boolean;
  lockedBy?: string | null;
  lockedLabel?: string | null;
  /** The last thing the user typed, from the SERVER transcript — so a session
   *  started on another machine says what it was about. */
  lastUserMessage?: string | null;
  /** The model-written title — what the session is building (server-computed). */
  name?: string | null;
  /** Who drives the session: 'supervisor' for looper-run card sessions. */
  agent?: string | null;
  card?: number | null;
  /** Where the session's work stands (server-computed from its checkout,
   *  only when the list was fetched with git=true): not_pushed = only on
   *  the server's disk, not_merged = on origin's branch but not in base,
   *  merged = in base. null/absent = nothing to measure. */
  work?: 'not_pushed' | 'not_merged' | 'merged' | null;
}

/** The `work` column: the git facts in the operator's terms, each with its
 *  severity mark — the colored • the table draws ahead of the words. Red is
 *  work that exists ONLY on the server's disk (a trash or a sweep loses it),
 *  yellow is safe on origin but not yet in base, green is done. One map, so
 *  the words and the color cannot disagree. */
const WORK = {
  not_pushed: { text: 'not pushed', mark: 'red' },
  not_merged: { text: 'not merged', mark: 'yellow' },
  merged: { text: 'merged', mark: 'green' },
} as const;

export type Launch =
  | { kind: 'resume'; sessionId: string }
  | { kind: 'new'; workspaceId: string }
  | { kind: 'add' };

export const label = (w: WorkspaceInfo) => w.displayName || w.name;

/** The workspace of the newest session the USER drove — boot_last_workspace's
 *  pick. Looper-run sessions (`agent` stamped by the loop path) work at all
 *  hours and would teleport the boot, so they do not count; nor does a
 *  session whose workspace is gone. A destroyed session still counts — its
 *  files are swept, but it is still where you were. Undefined = nothing
 *  eligible, show the picker. */
export function lastWorkspaceId(workspaces: WorkspaceInfo[], sessions: SessionInfo[]): string | undefined {
  const known = new Set(workspaces.map((w) => w.id));
  return sessions
    .filter((s) => !s.agent && known.has(s.workspaceId))
    .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))[0]?.workspaceId;
}

/** IS A TURN LIVE IN THIS SESSION — the one definition, shared by the /resume
 *  table and the Assistant's session_list, because a session that reads
 *  "running" on screen and "idle" when the Assistant is asked is one fact with
 *  two answers. Two ways to be running: a turn streaming in THIS window
 *  (`busy`), or someone else holding the lock — locks are per TURN, so a hold
 *  by anyone but us IS a turn running over there. An ended session never runs. */
export function isRunning(s: SessionInfo,
  opts: { busy?: (sessionId: string) => boolean; clientId?: string } = {}): boolean {
  if (s.status !== 'active') return false;
  return (opts.busy?.(s.id) ?? false) || (!!s.locked && s.lockedBy !== (opts.clientId ?? ''));
}

/** "2h" — coarse on purpose; the exact minute never matters here. */
export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 90) return 'now';
  const m = s / 60;
  if (m < 90) return `${Math.round(m)}m`;
  const h = m / 60;
  if (h < 36) return `${Math.round(h)}h`;
  const d = Math.round(h / 24);
  return d < 8 ? `${d}d` : `${Math.round(d / 7)}w`;
}

/** Session rows — /resume. A session is
 *  what you actually reopen: it carries the branch and the conversation. */
export function sessionChoices(
  workspaces: WorkspaceInfo[],
  sessions: SessionInfo[],
  lastMessage: (sessionId: string) => string | undefined,
  now = Date.now(),
  busy: (sessionId: string) => boolean = () => false,
  loaded: (sessionId: string) => boolean = () => false,
  clientId = '',
  showSupervised = false,
): Choice<Launch | null>[] {
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  // WHICH sessions are listed is the server's call (`GET /sessions?typed=
  // true&supervisor=false` — never-typed rows and the looper's supervisor
  // seats left out there, so a page is a page on screen and the count is
  // real). The one thing only this window knows is what is OPEN here: an
  // open session nothing was typed into yet would be missing from the
  // server's list, and /resume is the switcher — hiding an open session
  // would strand it. App merges those in (`sessions` already carries them).
  // Rows in MOTION (a turn here, a hold elsewhere — the looper included)
  // sort first; the rest by last use. A held row's own lastUsedAt can be old,
  // which made the list read as unordered.
  const inMotion = (s: SessionInfo) => isRunning(s, { busy, clientId });
  sessions = [...sessions].sort((a, b) =>
    Number(inMotion(b)) - Number(inMotion(a))
    || Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
  if (!sessions.length) {
    return showSupervised
      ? [{ value: null, label: 'no sessions yet', detail: 'start one with /workspace', heading: true }]
      : [{ value: null, label: 'no sessions yet',
          detail: 'start one with /workspace · [s] shows the looper\'s card sessions', heading: true }];
  }
  // The workspace column is its card prefix ("PHA") — the resolved value the
  // server sends on the list; a server without it falls back to the label. A
  // workspace that no longer exists has nothing to show: the dot, NEVER the
  // raw 26-char id — one such row (old sessions of a deleted workspace, which
  // lazy loading now reaches) blew the label column to its cap and pushed the
  // whole table past the terminal's edge.
  const wsCol = (s: SessionInfo): string => {
    const w = byId.get(s.workspaceId);
    return w ? (w.cardPrefix ?? label(w)) : '·';
  };
  // Columns ride the shared table system (table.ts — /resume's geometry made
  // reusable): fixed widths on the value columns, because this list refreshes
  // in place and must not jitter as messages and names change under it.
  // card is 6 = the title (4) + the 2-cell gutter inside the width (the
  // column law), room for four digits; it sits right of ws so `PHA  7` reads
  // as the board's PHA-7 and survives a narrow terminal. work is 14 = the
  // mark and its space (2) + "not pushed"/"not merged" (10) + the gutter; it
  // sits LEFT of who/when so a narrow terminal truncates the tail columns
  // before the one that says whether work would be lost.
  const COLS = { card: 6, name: 28, who: 12, msg: 32, work: 14 };
  const rows = sessions.map((s): TableRow<Launch | null> => {
    const w = byId.get(s.workspaceId);
    // The server's transcript says what a conversation was about wherever it
    // was typed; the local file covers a server that stores none.
    // A supervisor session names itself: the looper's verdict record for its
    // card — read-only.
    const sup = s.agent === 'supervisor';
    const dead = s.status !== 'active';
    const working = !dead && busy(s.id);
    // Loaded in THIS window's memory (running wins the marker slot).
    const open = !dead && loaded(s.id);
    // Locked by someone else = a turn IS running there right now (locks are
    // per turn) — same spinner as a local turn. One fact, one place.
    const held = !dead && !!s.locked && s.lockedBy !== clientId;
    const running = isRunning(s, { busy, clientId });   // === working || held
    // Who drives the session: the looper's coding agent, the looper's
    // supervisor record, or you.
    const kind = sup ? 'supervisor' : s.card != null ? 'looper' : 'manual';
    // The card this session works on — the BARE number, because the ws
    // column beside it already shows the prefix (the board's own shape:
    // prefix in the header, number on the row). Either seat of a loop
    // carries it; a session with no card is the blank-fact dot.
    const cardCol = s.card != null ? String(s.card) : '·';
    // Two facts, two columns: the session's NAME (what is being built) and
    // the last thing typed. A blank fact is a dot — never the branch, which
    // is just the session id wearing a prefix and says nothing to a person.
    const msg = s.lastUserMessage ?? lastMessage(s.id);
    const nameCol = s.name ?? '·';
    const msgCol = sup ? 'verdicts · read-only'
      : msg ? `"${msg}"`
      : '·';
    const when = dead ? 'ended' : ago(s.lastUsedAt, now);
    // A blank work fact is the dot, UNMARKED — a color would claim a state
    // the server did not give: the list may not have been fetched with
    // git=true yet (the instant first paint), or there is nothing to measure.
    const workCol = s.work ? WORK[s.work] : '·';
    return {
      value: { kind: 'resume', sessionId: s.id } as Launch,
      cells: [wsCol(s), cardCol, nameCol, msgCol, workCol, kind, when],
      busy: running,
      dot: open && !running,
      hint: dead
        ? `Ended — reopening restarts it and checks ${s.branch} back out.`
        : held
          ? `${s.branch} — a turn is running (${s.lockedLabel || 'another machine'}); read freely — sends are refused while it runs`
          : open
            ? `${s.branch} — loaded in this window, enter switches to it`
            : sup ? `the looper's rounds and verdicts for card ${s.card ?? '?'} — read-only` : s.branch,
    };
  });
  return tableChoices('ws', [
    { title: 'card', width: COLS.card },
    { title: 'session', width: COLS.name }, { title: 'last message', width: COLS.msg },
    { title: 'work', width: COLS.work },
    { title: 'who', width: COLS.who }, { title: 'when' },
  ], rows);
}

/** Workspace rows — launching with no arguments, and /workspace. Always ends
 *  with "add a workspace…": an empty install has to be able to get started from
 *  here, not from curl. */
export function workspaceChoices(workspaces: WorkspaceInfo[], canAdd = true): Choice<Launch | null>[] {
  const rows: Choice<Launch | null>[] = workspaces.map((w) => ({
    value: { kind: 'new', workspaceId: w.id } as Launch,
    label: label(w),
    detail: `${w.owner}/${w.name}`,
  }));
  if (canAdd) {
    rows.push({ value: { kind: 'add' } as Launch, label: 'add a workspace…',
      detail: workspaces.length ? '' : 'nothing here yet — start with this' });
  }
  return rows;
}

/** One list, two uses. `mode` decides which — sessions for /resume, workspaces
 *  for a fresh start. Deliberately not both at once: launching means "start
 *  work", reopening is a different intent with its own command. */
export function Launcher({ mode, workspaces, sessions, total, lastMessage, busy, loaded, clientId, onPick, onEdit, onDuplicate, onClose, onTrash, onCancel, onNearEnd, showSupervised, onToggleSupervised, now, title, footer, notice, canAdd }: {
  mode: 'sessions' | 'workspaces';
  workspaces: WorkspaceInfo[];
  sessions?: SessionInfo[];
  /** How many sessions the whole list holds (the server's count for the
   *  filters in force, plus what this window merged in) — `sessions` is the
   *  pages loaded so far. Omitted = the loaded rows are the list. */
  total?: number;
  /** The looper's supervisor seats are hidden unless this is on; [s] asks
   *  the owner to flip it (the list is re-read with the switch). */
  showSupervised?: boolean;
  onToggleSupervised?: () => void;
  lastMessage?: (sessionId: string) => string | undefined;
  /** Is this session running a turn in THIS window right now? The server list
   *  cannot know; the SessionStore can. */
  busy?: (sessionId: string) => boolean;
  /** Is this session loaded in THIS window (running or not)? Same source as
   *  `busy` — the SessionStore — drawn as a steady dot on idle rows. */
  loaded?: (sessionId: string) => boolean;
  /** This window's own lock id, so its own held sessions do not read "in use". */
  clientId?: string;
  onPick: (l: Launch) => void;
  /** `e` on a workspace row. Absent => the key does nothing and is not offered. */
  onEdit?: (workspaceId: string) => void;
  /** `d` on a session row: duplicate it into a new session — the way past a lock. */
  onDuplicate?: (sessionId: string) => void;
  /** `x` on a session row: close it — out of local memory (the tab ring, the
   *  open-session list, the dot). The session stays on the server. */
  onClose?: (sessionId: string) => void;
  /** `t` on a session row: trash it for good (row + transcript). */
  onTrash?: (sessionId: string) => void;
  onCancel?: () => void;
  /** The cursor neared the bottom of the list — /resume loads its next page
   *  of sessions here (SelectList's onNearEnd, passed straight through). */
  onNearEnd?: () => void;
  now?: number;
  title?: string;
  footer?: FooterKey[];
  /** One yellow line under the title — trash refusals speak here, where the
   *  list is, not into a conversation the menu is covering. */
  notice?: string;
  canAdd?: boolean;
}) {
  // Editing is offered only where there is something to edit: workspace rows,
  // and not the "add a workspace…" row that sits with them.
  const canEdit = mode === 'workspaces' && !!onEdit;
  const canCopy = mode === 'sessions' && !!onDuplicate;
  // The looper's card sessions are hidden by default; [s] toggles them in.
  const choices = mode === 'sessions'
    ? sessionChoices(workspaces, sessions ?? [], lastMessage ?? (() => undefined), now, busy, loaded, clientId, showSupervised ?? false)
    : workspaceChoices(workspaces, canAdd ?? true);
  return (
    <Screen title={title ?? (mode === 'sessions' ? 'resume' : 'workspace')}
      notice={notice}
      footer={footer ?? (canEdit
        ? [{ key: 'enter', does: 'start work here' }, { key: 'e', does: 'edit workspace' },
          { key: 'n', does: 'new workspace', when: canAdd ?? true }, { key: 'esc', does: 'close' }]
        : [
          { key: 'enter', does: 'open' },
          { key: 'd', does: 'duplicate', when: canCopy }, { key: 'x', does: 'close', when: canCopy },
          { key: 't', does: 'trash', when: canCopy },
          { key: 's', does: 'supervised', when: canCopy }, { key: 'esc', does: 'close' },
        ])}>
      <SelectList
        choices={choices}
        onNearEnd={onNearEnd}
        // The block is window-tall from the first frame — pages landing
        // below never change its height — and counts against the real total.
        pad={mode === 'sessions'}
        total={mode === 'sessions' ? total : undefined}
        onSelect={(v) => { if (v) onPick(v); }}
        onKey={canEdit ? (ch, v) => {
          if (ch === 'e' && v?.kind === 'new') onEdit!(v.workspaceId);
          // The same act as the "add a workspace…" row, one key from any row.
          else if (ch === 'n' && (canAdd ?? true)) onPick({ kind: 'add' });
        } : mode === 'sessions' ? (ch, v) => {
          if (ch === 's') { onToggleSupervised?.(); return; }
          if (v?.kind !== 'resume') return;
          if (ch === 'd') onDuplicate?.(v.sessionId);
          else if (ch === 'x') onClose?.(v.sessionId);
          else if (ch === 't') onTrash?.(v.sessionId);
        } : undefined}
        onCancel={onCancel}
      />
    </Screen>
  );
}
