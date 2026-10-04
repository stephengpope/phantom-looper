// What you see when the TUI starts with nothing to attach to. Sessions first,
// because a session is what you actually resume — it carries the branch and the
// conversation. Projects are the layer below, for starting something new.
//
// The boot-time shortcut past this screen is `boot_last_project` (a server
// setting, on by default): the sessions list already records where you were,
// so the pick comes off the newest session the user drove — never a pinned
// project id, which goes stale the moment you switch.
import { Box } from 'ink';
import { useInput } from './useInput.js';
import { useState } from 'react';
import { SelectList, type Choice } from './SelectList.js';
import { Screen, type FooterKey } from './Screen.js';
import { TextInput } from './TextInput.js';
import { FixedText } from './Text.js';
import { tableChoices, type TableRow, type Cell } from './table.js';
import { formatTokensIn, formatTokensOut, cachePct } from '../state.js';

export interface ProjectInfo {
  id: string; owner: string; name: string; displayName?: string | null;
  /** The resolved card number prefix ("PHA") — the server's, never derived here. */
  cardPrefix?: string;
}
/** A session row as the server lists it — core's one shape. */
export type { SessionRow as SessionInfo } from '../../core/sessionRows.js';
import type { SessionRow as SessionInfo } from '../../core/sessionRows.js';

/** The `work` column: the git facts in the operator's terms, each with its
 *  severity mark — the colored • the table draws ahead of the words. Red is
 *  work that exists ONLY on the server's disk (a trash or a sweep loses it),
 *  yellow is safe on origin but not yet in base, green is done. One map, so
 *  the words and the color cannot disagree. */
export const WORK = {
  not_pushed: { text: 'not pushed', mark: 'red' },
  not_merged: { text: 'not merged', mark: 'yellow' },
  merged: { text: 'merged', mark: 'green' },
} as const;

/** The icon per card status — core's one map (core/kanban.ts), for /resume's
 *  card column and the board's column headers. The icon replaces the word. */
export { STATUS_ICON } from 'phantom-client-sdk';
import { STATUS_ICON } from 'phantom-client-sdk';

export type Launch =
  | { kind: 'resume'; sessionId: string }
  | { kind: 'new'; projectId: string }
  | { kind: 'add' };

export const label = (project: ProjectInfo) => project.displayName || project.name;

/** The project of the newest session the USER drove — boot_last_project's
 *  pick. Sessions a card run or a cron drives (whoDrives) work at all hours
 *  and would teleport the boot, so they do not count; nor does a session
 *  whose project is gone. A destroyed session still counts — its files are
 *  swept, but it is still where you were. Undefined = nothing eligible,
 *  show the picker. */
export function lastProjectId(projects: ProjectInfo[], sessions: SessionInfo[]): string | undefined {
  const known = new Set(projects.map((project) => project.id));
  return sessions
    .filter((session) => whoDrives(session) === 'manual' && known.has(session.projectId))
    .sort((a, b) => Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt))[0]?.projectId;
}

/** Who drives, is a turn live, how long ago — core's one definition of
 *  each (core/sessionRows.ts), shared with the Assistant's session_list. */
export { whoDrives, isRunning, ago, type Driver } from '../../core/sessionRows.js';
import { whoDrives, isRunning, ago } from '../../core/sessionRows.js';

/** Session rows — /resume. A session is
 *  what you actually reopen: it carries the branch and the conversation. */
export function sessionChoices(
  projects: ProjectInfo[],
  sessions: SessionInfo[],
  now = Date.now(),
  busy: (sessionId: string) => boolean = () => false,
  loaded: (sessionId: string) => boolean = () => false,
  clientId = '',
  showBackground = false,
  query = '',
  projectId: string | null = null,
): Choice<Launch | null>[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  // WHICH sessions are listed is the server's call (`GET /sessions?typed=
  // true&background=false` — never-typed rows and the background seats, the
  // supervisor sessions and cron runs, left out there, so a page is
  // a page on screen and the count is real). The one thing only this window knows is what is OPEN here: an
  // open session nothing was typed into yet would be missing from the
  // server's list, and /resume is the switcher — hiding an open session
  // would strand it. App merges those in (`sessions` already carries them).
  // PINNED rows sit first (/pin, [p] on a row) — the one order the server
  // already returns; this sort only has to keep it while adding what the
  // server cannot know: rows in MOTION (a turn here, a hold elsewhere — the
  // looper included) sort next; the rest by last use. A held row's own
  // lastUsedAt can be old, which made the list read as unordered.
  const inMotion = (session: SessionInfo) => isRunning(session, { busy, clientId });
  sessions = [...sessions].sort((a, b) =>
    Number(b.pinned === true) - Number(a.pinned === true)
    || Number(inMotion(b)) - Number(inMotion(a))
    || Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt));
  if (!sessions.length) {
    // The empty state names the filter that emptied it: the text, else the
    // project, else the list is truly empty and says where to start.
    const where = projectId ? ` in ${projectTitle(projects, projectId)}` : '';
    if (query.trim()) return [{ value: null, label: `no sessions match “${query.trim()}”${where}`, heading: true }];
    if (projectId) return [{ value: null, label: `no sessions${where}`, detail: '←→ another project', heading: true }];
    return showBackground
      ? [{ value: null, label: 'no sessions yet', detail: 'start one with /project', heading: true }]
      : [{ value: null, label: 'no sessions yet',
          detail: 'start one with /project · [s] shows every session, supervisor records and cron runs included', heading: true }];
  }
  // The project column is its card prefix ("PHA") — the resolved value the
  // server sends on the list; a server without it falls back to the label. A
  // project that no longer exists has nothing to show: the dot, NEVER the
  // raw 26-char id — one such row (old sessions of a deleted project, which
  // lazy loading now reaches) blew the label column to its cap and pushed the
  // whole table past the terminal's edge.
  const wsCol = (session: SessionInfo): string => {
    const project = byId.get(session.projectId);
    return project ? (project.cardPrefix ?? label(project)) : '·';
  };
  // Columns ride the shared table system (table.ts — /resume's geometry made
  // reusable): fixed widths on the value columns, because this list refreshes
  // in place and must not jitter as messages and names change under it.
  // The ORDER is the status bar's: card number with a colored status icon
  // first (`PHA  ○ 7` — dim hollow circle = backlog), the model with its
  // token meters near the end (`gpt-5 ↑ 12.4k (84%) ↓ 1.7k`).
  // card is 8 = number (4) + the mark (2) + the 2-cell gutter — compact, the
  // icon trails the number (`7 ▶`) so the numbers stay left-aligned.
  // Status icons: ○ gray (backlog), ◇ magenta (plan), ▶ yellow (in_progress),
  //               ✕ red (blocked), ✓ green (done).
  // work is 14 = the mark and its space (2) + "not pushed"/"not merged" (10)
  // + the gutter. tokens is 24 = the widest meter pair
  // ("↑ 12.4k (100%) ↓ 12.4k", 22) + the gutter. who and when ride in ONE
  // free-running last column ("coder 2h") — one question ("whose is this
  // and how fresh"), one column.

  const COLS = { card: 8, workState: 14, name: 42, model: 20, tokens: 24 };
  const rows = sessions.map((session): TableRow<Launch | null> => {
    // A supervisor session names itself: the supervisor's conversation for its
    // card — read-only. A cron's run is a normal coding session that a
    // schedule opened; typing into it takes it over (whoDrives).
    const sup = session.agent === 'supervisor';
    const cron = whoDrives(session) === 'cron';
    const dead = session.status !== 'active';
    // Loaded in THIS window's memory (running wins the marker slot).
    const open = !dead && loaded(session.id);
    // Locked by someone else = a turn IS running there right now (locks are
    // per turn) — same spinner as a local turn. One fact, one place.
    const held = !dead && !!session.locked && session.lockedBy !== clientId;
    const running = isRunning(session, { busy, clientId });   // a local turn, or held elsewhere
    // The card this session works on — the BARE number, because the project
    // column beside it already shows the prefix (the board's own shape:
    // prefix in the header, number on the row). Either seat of a loop
    // carries it; a session with no card is the blank-fact dot.
    // Card number with a colored status icon as the mark: ▶ 7 (yellow = in_progress).
    const cardNum = session.card != null ? String(session.card) : '·';
    const icon = session.cardStatus ? STATUS_ICON[session.cardStatus] : undefined;
    const cardCol: Cell = icon
      ? { text: cardNum, mark: icon.color, markChar: icon.char, markAfter: true }
      : cardNum;
    // A blank fact is a dot — never the branch, which is just the session id
    // wearing a prefix and says nothing to a person.
    const nameCol = session.name ?? '·';
    // A session open here that nothing was typed into carries no activity
    // time (App's merge fills epoch 0 so it sorts last) — the dot, not "2957w".
    const when = Date.parse(session.lastUsedAt) > 0 ? ago(session.lastUsedAt, now) : '·';
    // A blank work fact is the dot, UNMARKED — a color would claim a state
    // the server did not give: the list may not have been fetched with
    // git=true yet (the instant first paint), or there is nothing to measure.
    const workCol = session.workState ? WORK[session.workState] : session.lastUserMessage ? { text: 'unknown', mark: 'gray' } : '·';
    // The token meters are the status bar's own shapes (`↑ 12.4k`,
    // `↓ 1.7k`) and its own rule: zero or unknown is no news, the blank-fact
    // dot. The cache hit rate rides the INPUT meter — caching is a property
    // of prompt tokens, never of output — by state.ts's one rule.
    const pct = cachePct(session.tokensInput ?? 0, session.tokensCacheRead ?? 0, session.tokensCacheWrite ?? 0);
    const inMeter = session.tokensInput
      ? formatTokensIn(session.tokensInput) + (pct != null ? ` (${pct}%)` : '') : '';
    const outMeter = session.tokensOutput ? formatTokensOut(session.tokensOutput) : '';
    const tokensCol = [inMeter, outMeter].filter(Boolean).join(' ') || '·';
    // ☠ = no workspace (the disk sweep took it). The time stays — when it was
    // last touched is still the fact that matters.
    const whenCol: Cell = dead ? { text: when, mark: 'gray', markChar: '☠', markAfter: true } : when;
    return {
      value: { kind: 'resume', sessionId: session.id } as Launch, id: session.id,
      cells: [wsCol(session), cardCol, workCol, nameCol, session.model ?? '·', tokensCol, whenCol],
      busy: running,
      dot: open && !running,
      hint: [
        session.name ?? undefined,
        held
          ? `A turn is running (${session.lockedLabel || 'another machine'}); read freely — sends are refused while it runs.`
          : open
            ? 'Loaded in this window — enter switches to it.'
            : sup ? `The supervisor's conversation for card ${session.card ?? '?'} — read-only.`
            : cron ? 'A scheduled prompt\'s run (cron) — chat into it and it is yours.' : undefined,
      ].filter(Boolean).join('\n') || undefined,
    };
  });
  const table = tableChoices('ws', [
    { title: 'card', width: COLS.card },
    { title: 'git', width: COLS.workState },
    { title: 'session', width: COLS.name },
    { title: 'model', width: COLS.model }, { title: 'tokens', width: COLS.tokens },
    { title: 'when' },
  ], rows);
  // One blank line between the pinned block and the rest — a heading row, so
  // the cursor skips it and the total counts sessions only. Only when both
  // groups exist: a list that is all-pinned or all-unpinned reads as one.
  // Inserted AFTER tableChoices so the column geometry never sees it (the
  // header sits at index 0, the pinned block right under it).
  const pinnedCount = sessions.filter((session) => session.pinned === true).length;
  if (pinnedCount > 0) {
    // A small group header: pin icon above the pinned block.
    table.splice(1, 0, { value: null, label: '📌', heading: true });
    // Blank separator between pinned and non-pinned (only when both exist).
    if (pinnedCount < rows.length) {
      // +2: table header at 0, pin heading at 1, then pinnedCount rows.
      table.splice(2 + pinnedCount, 0, { value: null, label: '', heading: true });
    }
  }
  return table;
}

/** What /resume's title calls the project filter: the display name, or
 *  `all`. A project the list no longer knows (deleted while the picker
 *  was up) reads as all rather than as a raw id. */
export const projectTitle = (projects: ProjectInfo[], id: string | null): string => {
  const project = id ? projects.find((project) => project.id === id) : undefined;
  return project ? label(project) : 'all';
};

/** Project rows — launching with no arguments, and /project: the card
 *  prefix (`PHA`) and the repo (`owner/name`), the same two columns the
 *  slash menu shows for `/new` and `/project` — nothing twice. Always ends
 *  with "add a project…": an empty install has to be able to get started from
 *  here, not from curl. */
export function projectChoices(projects: ProjectInfo[], canAdd = true): Choice<Launch | null>[] {
  const rows: Choice<Launch | null>[] = projects.map((project) => ({
    value: { kind: 'new', projectId: project.id } as Launch,
    label: project.cardPrefix ?? label(project),
    detail: `${project.owner}/${project.name}`,
  }));
  if (canAdd) {
    rows.push({ value: { kind: 'add' } as Launch, label: 'add a project…',
      detail: projects.length ? '' : 'nothing here yet — start with this' });
  }
  return rows;
}

/** One list, two uses. `mode` decides which — sessions for /resume, projects
 *  for a fresh start. Deliberately not both at once: launching means "start
 *  work", reopening is a different intent with its own command. */
export function Launcher({ mode, projects, sessions, total, busy, loaded, clientId, onPick, onEdit, onDuplicate, onPin, onPing, onClose, onTrash, onCancel, onNearEnd, showBackground, onToggleBackground, query = '', rowsQuery = query, onQuery, projectId = null, onCycleProject, now, title, footer, notice, canAdd }: {
  mode: 'sessions' | 'projects';
  /** ←→ on /resume: the project the rows are limited to (null = all),
   *  and the cycle. Like the filter line, the rows are the server's answer
   *  (WindowStore.pickerProject); this screen names it in the title.
   *  Absent = no cycle offered. */
  projectId?: string | null;
  onCycleProject?: (dir: 1 | -1) => void;
  /** [/] on /resume: the filter line's text, and where it goes. The list
   *  is the server's answer to it (WindowStore.pickerQuery); this screen
   *  only owns whether the line is OPEN. Absent = no filter offered. */
  query?: string;
  /** The filter `sessions` ANSWER — the live text runs ahead of the rows
   *  by one read, and the empty state must name what the rows are for, or
   *  esc on a zero-match filter draws "no sessions yet" for a frame. */
  rowsQuery?: string;
  onQuery?: (query: string) => void;
  projects: ProjectInfo[];
  sessions?: SessionInfo[];
  /** How many sessions the whole list holds (the server's count for the
   *  filters in force, plus what this window merged in) — `sessions` is the
   *  pages loaded so far. Omitted = the loaded rows are the list. */
  total?: number;
  /** The background seats — supervisor sessions and cron runs —
   *  are hidden unless this is on; [s] asks the owner to flip it (the list
   *  is re-read with the switch). */
  showBackground?: boolean;
  onToggleBackground?: () => void;
  /** Is this session running a turn in THIS window right now? The server list
   *  cannot know; the SessionStore can. */
  busy?: (sessionId: string) => boolean;
  /** Is this session loaded in THIS window (running or not)? Same source as
   *  `busy` — the SessionStore — drawn as a steady dot on idle rows. */
  loaded?: (sessionId: string) => boolean;
  /** This window's own lock id, so its own held sessions do not read "in use". */
  clientId?: string;
  onPick: (launch: Launch) => void;
  /** `e` on a project row. Absent => the key does nothing and is not offered. */
  onEdit?: (projectId: string) => void;
  /** `d` on a session row: duplicate it into a new session — the way past a lock. */
  onDuplicate?: (sessionId: string) => void;
  /** `p` on a session row: pin it to the top of the list (or take it down). */
  onPin?: (sessionId: string) => void;
  /** `i` on a session row: ping the container — start it and mark the checkout used — so git status can be checked. */
  onPing?: (sessionId: string) => void;
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
  // Editing is offered only where there is something to edit: project rows,
  // and not the "add a project…" row that sits with them.
  const canEdit = mode === 'projects' && !!onEdit;
  const canCopy = mode === 'sessions' && !!onDuplicate;
  const canPin = mode === 'sessions' && !!onPin;
  const canPing = mode === 'sessions' && !!onPing;
  const canFilter = mode === 'sessions' && !!onQuery;
  const canCycle = mode === 'sessions' && !!onCycleProject;
  // ←→ work in BOTH states — the list and the filter line — because the two
  // filters compose: the text searches inside the project. The filter
  // line is a single-line input and leaves the arrows alone (TextInput).
  useInput((_ch, key) => {
    if (key.leftArrow) onCycleProject!(-1);
    else if (key.rightArrow) onCycleProject!(1);
  }, { isActive: canCycle });
  // The title carries the project filter, so the list always says what
  // it is a list OF: `resume · ‹ all ›`, `resume · ‹ phantom ›`.
  const heading = title ?? (mode === 'sessions'
    ? (canCycle ? `resume · ‹ ${projectTitle(projects, projectId)} ›` : 'resume')
    : 'project');
  // FILTER MODE is one state: [/] opens the line and the cursor lives in it;
  // type to narrow, ↑↓ to move, enter to open — nothing else. esc clears
  // the text AND closes the line, so the list comes back exactly as it was
  // with its letter keys. Key ownership is the combobox split (ValueInput):
  // TextInput takes the letters and, given no onSubmit, ignores enter;
  // SelectList takes ↑↓/enter and, given no onKey, ignores the letters.
  const [filtering, setFiltering] = useState(false);
  const leaveFilter = () => { setFiltering(false); onQuery?.(''); };
  useInput((_ch, key) => { if (key.escape) leaveFilter(); }, { isActive: filtering });
  // The background seats are hidden by default; [s] shows every session.
  const choices = mode === 'sessions'
    ? sessionChoices(projects, sessions ?? [], now, busy, loaded, clientId, showBackground ?? false, rowsQuery, projectId)
    : projectChoices(projects, canAdd ?? true);
  if (filtering) {
    return (
      <Screen title={heading} notice={notice}
        footer={[{ key: 'type', does: 'filter' }, { key: '↑↓', does: 'move' },
          { key: '←→', does: 'project', when: canCycle, active: projectId !== null }]}>
        <Box marginBottom={1}>
          <FixedText color="cyan">{'  / '}</FixedText>
          <TextInput value={query} onChange={(query) => onQuery!(query)} placeholder="name, last message or branch…" />
        </Box>
        <SelectList
          choices={choices}
          reserve={2}
          onNearEnd={onNearEnd}
          total={total}
          onSelect={(pick) => { if (pick) onPick(pick); }}
        />
      </Screen>
    );
  }
  return (
    <Screen title={heading}
      notice={notice}
      // No [enter]/[esc] in either footer: they do what they do everywhere,
      // and the footer's width is better spent on the letter keys you cannot guess.
      footer={footer ?? (canEdit
        ? [{ key: 'e', does: 'edit project' }, { key: 'n', does: 'new project', when: canAdd ?? true }]
        : [
          // Lit while a project is picked, like [s] — the filter holds
          // across opens, so the key must say it is on.
          { key: '←→', does: 'project', when: canCycle, active: projectId !== null },
          { key: '/', does: 'filter', when: canFilter },
          { key: 'p', does: 'pin', when: canPin },
          { key: 'x', does: 'close', when: canCopy },
          { key: 'd', does: 'duplicate', when: canCopy },
          { key: 't', does: 'trash', when: canCopy },
          { key: 'i', does: 'ping', when: canPing },
          { key: 's', does: 'show all', when: canCopy, active: showBackground },
        ])}>
      <SelectList
        choices={choices}
        onNearEnd={onNearEnd}
        // `total` counts against the real total — the "↓ N more" line says
        // what is really below, not what happens to be loaded.
        total={mode === 'sessions' ? total : undefined}
        onSelect={(pick) => { if (pick) onPick(pick); }}
        onKey={canEdit ? (char, pick) => {
          if (char === 'e' && pick?.kind === 'new') onEdit!(pick.projectId);
          // The same act as the "add a project…" row, one key from any row.
          else if (char === 'n' && (canAdd ?? true)) onPick({ kind: 'add' });
        } : mode === 'sessions' ? (char, pick) => {
          if (char === '/' && canFilter) { setFiltering(true); return; }
          if (char === 's') { onToggleBackground?.(); return; }
          if (pick?.kind !== 'resume') return;
          if (char === 'd') onDuplicate?.(pick.sessionId);
          else if (char === 'p') onPin?.(pick.sessionId);
          else if (char === 'i') onPing?.(pick.sessionId);
          else if (char === 'x') onClose?.(pick.sessionId);
          else if (char === 't' || char === 'c') onTrash?.(pick.sessionId);
        } : undefined}
        onCancel={onCancel}
      />
    </Screen>
  );
}
