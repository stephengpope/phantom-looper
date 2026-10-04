// The card edit page — every field the schema has, always on screen, so what a
// card CAN hold is visible on an empty one.
//
// The focused row is a real TextInput (ours — cursor, arrows, home/end);
// every other row is plain text. Focus walks the rows with tab/shift+tab or
// ↑/↓, and lives in a REF read by the handler — two keypresses batched into
// one React update would both see a stale index otherwise and type into the
// previous field (the same rule TextInput and SelectList already follow).
// Details and the three lists are all lines: enter inserts a line below,
// backspace on an empty line removes it, ctrl+t ticks a checklist line. The
// Status row under the title shows the card's column and CYCLES it on
// enter/space or a click — straight through store.move (status carries pos,
// which only the store computes), landing at the end of the next column,
// the board's own tab-move rule. The
// mouse clicks anything: a row to focus it, a checklist box to toggle it.
// There is no Save: edits AUTO-SAVE — a debounced (600ms) flush PATCHes only
// the fields that changed (one PATCH per pause, because every PATCH writes a
// revision row server-side), esc flushes what is pending and closes, and the
// header's right corner says where the save stands (saving… / saved ✓). A
// patch the server REJECTED — or answered without closing the difference,
// which means it did not land either — is not retried until the draft changes
// again; the answer would otherwise re-arm the debounce forever. A store edit
// while the card is open (a kanban tool, the refresh) lands live: fields the
// user has not touched rebase to the incoming card, fields mid-edit keep the
// user's text. Every action is enter/space on its row (or a click): letter
// shortcuts were tried and dropped — a focused text row owns every letter,
// so the key meant "archive" on one row and typed into the Title on another.
import { Box, measureElement, type DOMElement } from 'ink';
import { useInput } from './useInput.js';
import { Text } from './Text.js';
import { useEffect, useRef, useState } from 'react';
import { isMouseInput, parseMouse } from '../mouse.js';
import { TextInput, TextArea } from './TextInput.js';
import { newKey } from 'phantom-client-sdk';
import type { BoardStore, CardStep, Card, CardPatch } from '../board.js';

type ListName = 'details' | 'requirements';
const SECTIONS: { list: ListName; label: string; hint: string }[] = [
  { list: 'details', label: 'Details', hint: 'facts the worker needs: constraints, edge cases, decisions made' },
  { list: 'requirements', label: 'Requires', hint: 'what must be true — tick each as you verify it' },
];

/** The looper's two per-card switches — auto_plan gates the plan column,
 *  auto_build gates in_progress. */
export type AutoField = 'auto_plan' | 'auto_build';

interface Draft {
  title: string; blocked: string; resolution: string;
  pinned: boolean; archived: boolean;
  auto_plan: boolean | null;
  auto_build: boolean | null;
  details: string[];
  requirements: CardStep[];
}

/** Each per-card switch cycles inherit → on → off (null = the project's
 *  setting of the same name decides). */
export const cycleAuto = (value: boolean | null): boolean | null =>
  value === null ? true : value === true ? false : null;

/** An Auto row's text: the EFFECTIVE value first, its source after — a card
 *  is opened to learn whether the looper will run it, so the answer never
 *  hides behind "inherit". */
export function autoLabel(value: boolean | null, fallback: boolean, source?: string): string {
  if (value !== null) return `${value ? 'on' : 'off'} · this card`;
  return `${fallback ? 'on' : 'off'} · ${source === 'project' ? 'project' : source === 'global' ? 'global' : 'default'}`;
}

/** Lists whose lines carry a done box — ctrl+t (or clicking the box) ticks. */
const tickable = (list: ListName) => list === 'requirements';
/** A prose row edits in a TextArea (wraps, owns the arrows); the title is
 *  the one single-line field. */
const prose = (row: Row) => row.kind === 'item' || (row.kind === 'field' && row.field !== 'title');

type Row =
  | { kind: 'field'; field: 'title' | 'blocked' | 'resolution' }
  | { kind: 'status' }
  | { kind: 'item'; list: ListName; index: number }
  | { kind: 'empty'; list: ListName }
  | { kind: 'pinned' }
  | { kind: 'archived' }
  | { kind: 'auto'; field: AutoField }
  | { kind: 'session' };

const rowKey = (row: Row) =>
  row.kind === 'field' ? row.field : row.kind === 'archived' ? 'archived'
  : row.kind === 'status' ? 'status'
  : row.kind === 'pinned' ? 'pinned'
  : row.kind === 'session' ? 'session'
  : row.kind === 'auto' ? row.field
  : row.kind === 'empty' ? `${row.list}+` : `${row.list}:${row.index}`;

/** Blocked is the STATUS — the reason row shows only for cards in the
 *  blocked column, where typing the why is the point. */
const showBlocked = (_draft: Draft, status: string) => status === 'blocked';

function buildRows(draft: Draft, status: string): Row[] {
  const rows: Row[] = [{ kind: 'field', field: 'title' }, { kind: 'status' }];
  for (const { list } of SECTIONS) {
    const count = draft[list].length;
    if (count === 0) rows.push({ kind: 'empty', list });
    else for (let i = 0; i < count; i++) rows.push({ kind: 'item', list, index: i });
  }
  if (showBlocked(draft, status)) rows.push({ kind: 'field', field: 'blocked' }, { kind: 'field', field: 'resolution' });
  // The loop block reads cause before effect: the two switches that decide
  // whether the looper runs this card, then the session that running it made.
  // Archived stays the bottom row; Pinned sits directly above it.
  rows.push({ kind: 'auto', field: 'auto_plan' }, { kind: 'auto', field: 'auto_build' },
    { kind: 'session' },
    { kind: 'pinned' }, { kind: 'archived' });
  return rows;
}

const itemText = (value: string | CardStep): string => typeof value === 'string' ? value : value.text;

const toDraft = (card: Card): Draft => ({
  title: card.title, blocked: card.blocked_reason ?? '', resolution: card.resolution ?? '',
  pinned: card.pinned, archived: card.archived, auto_plan: card.auto_plan ?? null, auto_build: card.auto_build ?? null,
  details: card.details ? card.details.split('\n') : [],
  requirements: card.requirements.map((step) => ({ ...step })),
});

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What the server does not yet have — every value CANONICAL (title trimmed,
 *  empty checklist lines dropped), so a flushed draft diffs to nothing and the
 *  debounce goes quiet instead of re-sending trim artifacts forever. */
function diffPatch(draft: Draft, step: Card): CardPatch {
  const patch: CardPatch = {};
  const title = draft.title.trim();
  if (title && title !== step.title) patch.title = title;

  const details = draft.details.join('\n').replace(/\n+$/, '');
  if (details !== step.details) patch.details = details;
  const blocked = draft.blocked.trim() || null;
  if (blocked !== step.blocked_reason) patch.blocked_reason = blocked;
  const resolution = draft.resolution.trim() || null;
  if (resolution !== (step.resolution ?? null)) patch.resolution = resolution;
  {
    // Both sides through ONE shape: `same` is JSON.stringify, so a field the
    // draft and the server spell in a different ORDER would read as a change
    // and re-arm the debounce forever.
    const canon = (step: CardStep): CardStep => ({ key: step.key, text: step.text.trim(), done: step.done });
    const steps = draft.requirements.map(canon).filter((step) => step.text);
    if (!same(steps, step.requirements.map(canon))) patch.requirements = steps;
  }
  if (draft.pinned !== step.pinned) patch.pinned = draft.pinned;
  if (draft.archived !== step.archived) patch.archived = draft.archived;
  if (draft.auto_plan !== (step.auto_plan ?? null)) patch.auto_plan = draft.auto_plan;
  if (draft.auto_build !== (step.auto_build ?? null)) patch.auto_build = draft.auto_build;
  return patch;
}

/** One PATCH per pause: shorter feels per-keystroke (a revision row each),
 *  longer loses edits to an impatient esc less gracefully. */
const SAVE_DEBOUNCE_MS = 600;

export function CardEditor({ store, card, width, height, prefix, isActive, onClose, onOpenSession }: {
  store: BoardStore; card: Card; width: number; height: number; prefix: string;
  isActive: boolean; onClose: () => void;
  /** Open the card's coding session in the chat view. Absent = the row still
   *  shows, but cannot open (tests, or a host without the wiring). */
  onOpenSession?: (id: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(card));
  // An edit from outside (either kanban tool, the 5s refresh) reaches an OPEN
  // editor as a new `card` prop. Rebase the draft against the snapshot it was
  // seeded from: a field the user has not touched takes the incoming value —
  // so a voice edit shows at once — and a field mid-edit keeps the user's
  // text. Compared by content, not identity: the refresh replaces every card
  // object without changing anything.
  const seedRef = useRef<Draft | null>(null);
  if (seedRef.current === null) seedRef.current = toDraft(card);
  useEffect(() => {
    const seed = seedRef.current!;
    const next = toDraft(card);
    if (same(next, seed)) return;
    seedRef.current = next;
    setDraft((draft) => {
      const merged = { ...draft };
      for (const key of Object.keys(next) as (keyof Draft)[])
        if (same(draft[key], seed[key])) (merged as Record<keyof Draft, unknown>)[key] = next[key];
      return merged;
    });
  }, [card]);
  // Focus lives in a ref and is READ from the ref (see the header comment).
  const atRef = useRef(0);
  const [, bump] = useState(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const rowRefs = useRef(new Map<string, DOMElement>());

  // ── the scroll ─────────────────────────────────────────────────────────────────
  // The form is taller than the box once a card has a few wrapped lines.
  // The header and the key line stay put; the form between them sits in a
  // clipped viewport and slides up by `scroll` rows (a negative top margin
  // on one non-shrinking wrapper — Pane's mechanism, proven against Ink
  // 7.1). FOCUS DRIVES IT: after every render the focused row is measured
  // against the viewport and the scroll moves just enough to show it, so
  // tab and the arrows never leave the cursor off screen. The wheel and
  // PgUp/PgDn nudge it by hand; the next focus move pulls it back.
  const viewRef = useRef<DOMElement>(null);
  const formRef = useRef<DOMElement>(null);
  const [scroll, setScroll] = useState(0);
  const scrollRef = useRef(0);
  scrollRef.current = scroll;
  /** How far the form can go, and the rows out of view either side — set
   *  by the measure after each render, read by the wheel and the footer. */
  const reach = useRef({ max: 0, view: 0 });
  const [hidden, setHidden] = useState({ above: 0, below: 0 });
  /** The row the view last followed. The follow runs when focus MOVES, not
   *  on every render — a wheel or PgUp scroll must stand until then, or a
   *  hand scroll that hides the focused row would snap straight back. */
  const followed = useRef(-1);
  const scrollTo = (row: number) => {
    const next = Math.max(0, Math.min(row, reach.current.max));
    if (next !== scrollRef.current) { scrollRef.current = next; setScroll(next); }
  };
  useEffect(() => {
    if (!viewRef.current || !formRef.current) return;
    const view = measureElement(viewRef.current);
    const form = measureElement(formRef.current);
    reach.current = { max: Math.max(0, form.height - view.height), view: view.height };
    const rowsNow = buildRows(draftRef.current, card.status);
    // Every row's place in the form, scroll-independent: its screen top
    // minus the form's (which already carries the margin).
    const place = (row: Row) => {
      const node = rowRefs.current.get(rowKey(row));
      if (!node) return null;
      const measured = measureElement(node);
      return { top: measured.y - form.y, bottom: measured.y - form.y + measured.height };
    };
    let next = scrollRef.current;
    const at = Math.min(atRef.current, rowsNow.length - 1);
    const followedPlace = followed.current !== at ? place(rowsNow[at]) : null;
    if (followedPlace) {
      followed.current = at;
      if (followedPlace.top < next) next = followedPlace.top;
      else if (followedPlace.bottom > next + view.height) next = followedPlace.bottom - view.height;
    }
    next = Math.max(0, Math.min(next, reach.current.max));
    let above = 0, below = 0;
    for (const row of rowsNow) {
      const placed = place(row);
      if (!placed) continue;
      if (placed.bottom <= next) above++;
      else if (placed.top >= next + view.height) below++;
    }
    if (above !== hidden.above || below !== hidden.below) setHidden({ above, below });
    if (next !== scrollRef.current) { scrollRef.current = next; setScroll(next); }
  });

  // The current loop's coding session, off the board payload — by number, so a
  // refresh replacing the card objects cannot orphan it.
  const cardSession = store.state.sessions?.[card.number];

  const rows = buildRows(draft, card.status);
  const at = Math.min(atRef.current, rows.length - 1);
  const row = rows[at];
  const setAt = (i: number) => { atRef.current = i; bump((tick) => tick + 1); };
  const move = (delta: number) => {
    const count = buildRows(draftRef.current, card.status).length;
    setAt((Math.min(atRef.current, count - 1) + delta + count) % count);
  };

  // Status is a MOVE, not a draft field: it carries pos, which only the
  // store computes, so the row cycles the column straight through
  // store.move — landing at the END of the target column, the board's own
  // tab-move rule, so both UIs move a card the same way. Read from
  // cardRef: a batched keypress right behind the optimistic update must
  // not cycle twice off a stale prop.
  const cycleStatus = () => {
    const cols = store.state.columns;
    if (!cols.length) return;
    const cur = cardRef.current;
    const next = cols[(Math.max(0, cols.indexOf(cur.status)) + 1) % cols.length];
    if (next === cur.status) return;
    void store.move(cur.id, next, store.cardsIn(next).length);
  };

  const setList = (list: ListName, update: (value: (string | CardStep)[]) => (string | CardStep)[]) =>
    setDraft((draft) => ({ ...draft, [list]: update(draft[list] as (string | CardStep)[]) }));
  // A checklist item is keyed HERE, not by the server. A keyless item comes
  // back from a save wearing a server-minted key, which the draft (mid-edit,
  // so never rebased) can never learn — the diff would never close, pinning
  // the corner on "saving…" and PATCHing every debounce for as long as the
  // editor stayed open. Keys are the card's own namespace, so uniqueness is
  // checked against the list in hand and the server's re-id path never fires.
  const newItem = (list: ListName, text = '', taken: (string | CardStep)[] = []): string | CardStep => {
    if (!tickable(list)) return text;
    const used = new Set(taken.map((item) => typeof item === 'string' ? '' : item.key));
    let key = newKey();
    while (used.has(key)) key = newKey();
    return { key, text, done: false };
  };
  const setItem = (list: ListName, index: number, text: string) =>
    setList(list, (value) => value.map((item, j) => j === index
      ? (typeof item === 'string' ? text : { ...item, text }) : item));
  const toggle = (list: ListName, index: number) =>
    setList(list, (value) => value.map((item, j) => j === index ? { ...(item as CardStep), done: !(item as CardStep).done } : item));
  const insertBelow = (list: ListName, index: number) => {
    setList(list, (value) => [...value.slice(0, index + 1), newItem(list, '', value), ...value.slice(index + 1)]);
    move(1);
  };

  // Auto-save. The debounce effect below arms a flush whenever the draft
  // differs from the card; flush() sends the diff and folds it into cardRef
  // at once, so a second flush (esc right behind the timer, the unmount
  // cleanup behind esc) diffs to nothing instead of PATCHing twice. A patch
  // that did not land — rejected, or answered with the difference still open
  // — is remembered and never re-sent verbatim: the answer changes the card
  // prop, which would re-arm the debounce into a retry storm; the next edit
  // produces a different patch and retries.
  const cardRef = useRef(card);
  cardRef.current = card;
  const [saveState, setSaveState] = useState<'rest' | 'saving' | 'saved' | 'failed'>('rest');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failedRef = useRef<string | null>(null);
  /** Saves in flight — while one is, "saving…" is the truth no matter what
   *  the optimistic card prop says. */
  const pendingRef = useRef(0);

  const flush = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    const patch = diffPatch(draftRef.current, cardRef.current);
    const sent = JSON.stringify(patch);
    if (!Object.keys(patch).length || failedRef.current === sent) return;
    const id = cardRef.current.id;
    cardRef.current = { ...cardRef.current, ...patch } as Card;
    setSaveState('saving');
    pendingRef.current++;
    void store.update(id, patch).then((err) => {
      pendingRef.current--;
      // A patch answered without closing the difference did not land either (a
      // field the server does not take, an item it re-keyed) — same failure as
      // a reject. The STORE, not cardRef, is asked: update() adopts the
      // server's card before it resolves, while the card prop waits on a
      // render.
      const server = store.state.cards.find((card) => card.id === id);
      const left = server ? JSON.stringify(diffPatch(draftRef.current, server)) : '{}';
      if (err || left === sent) { failedRef.current = sent; setSaveState('failed'); }
      else { failedRef.current = null; setSaveState('saved'); }
    });
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    const patch = diffPatch(draft, card);
    const sent = JSON.stringify(patch);
    if (!Object.keys(patch).length || failedRef.current === sent) {
      // Nothing left to send: the corner must not keep claiming a save is in
      // flight when none is.
      if (!pendingRef.current)
        setSaveState((state) => state !== 'saving' ? state : failedRef.current === sent ? 'failed' : 'saved');
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      return;
    }
    setSaveState('saving');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => flushRef.current(), SAVE_DEBOUNCE_MS);
  }, [draft, card]);
  useEffect(() => () => { flushRef.current(); }, []);

  // Structure keys only — every text key belongs to the focused TextInput.
  useInput((char, key) => {
    const rowsNow = buildRows(draftRef.current, card.status);
    const row = rowsNow[Math.min(atRef.current, rowsNow.length - 1)];
    if (isMouseInput(char)) {
      const mouse = parseMouse(char);
      if (mouse?.kind === 'wheel' && mouse.x < width) { scrollTo(scrollRef.current + mouse.button * 3); return; }
      if (mouse?.kind !== 'press' || mouse.button !== 0 || mouse.x >= width) return;
      // A row scrolled out of the viewport is not on screen to be clicked,
      // however its layout box measures.
      const view = viewRef.current ? measureElement(viewRef.current) : null;
      if (view && (mouse.y < view.y || mouse.y >= view.y + view.height)) return;
      for (let i = 0; i < rowsNow.length; i++) {
        const node = rowRefs.current.get(rowKey(rowsNow[i]));
        if (!node) continue;
        const measured = measureElement(node);
        if (mouse.x >= measured.x && mouse.x < measured.x + measured.width && mouse.y >= measured.y && mouse.y < measured.y + measured.height) {
          const hitRow = rowsNow[i];
          setAt(i);
          if (hitRow.kind === 'archived') setDraft((draft) => ({ ...draft, archived: !draft.archived }));
          if (hitRow.kind === 'pinned') setDraft((draft) => ({ ...draft, pinned: !draft.pinned }));
          if (hitRow.kind === 'status') cycleStatus();
          if (hitRow.kind === 'auto') setDraft((draft) => ({ ...draft, [hitRow.field]: cycleAuto(draft[hitRow.field]) }));
          if (hitRow.kind === 'session' && cardSession && onOpenSession) { flush(); onOpenSession(cardSession.id); }
          // The [ ] box renders right-justified inside the 12-column label
          // gutter — a click anywhere in that gutter ticks; on the text, it
          // just focuses.
          if (hitRow.kind === 'item' && tickable(hitRow.list) && mouse.x < measured.x + 13) toggle(hitRow.list, hitRow.index);
          return;
        }
      }
      return;
    }
    if (key.escape) { flush(); onClose(); return; }
    if (key.tab) { move(key.shift ? -1 : 1); return; }
    if (key.pageUp || key.pageDown) { scrollTo(scrollRef.current + (key.pageUp ? -1 : 1) * reach.current.view); return; }
    // Up/down move between rows — except on a prose row, where the TextArea
    // owns them and reports the edge (onBoundary), which moves.
    if ((key.upArrow || key.downArrow) && !prose(row)) { move(key.upArrow ? -1 : 1); return; }
    // ctrl+e — measured with `npm run keys` on the user's terminal, which
    // delivers only ctrl+e r l f d n v; t/k/y are eaten. ctrl+t kept as a
    // silent extra for terminals that do pass it.
    if (key.ctrl && (char === 'e' || char === 't') && row.kind === 'item' && tickable(row.list)) { toggle(row.list, row.index); return; }
    if (row.kind === 'auto') {
      if (key.return || char === ' ') { setDraft((draft) => ({ ...draft, [row.field]: cycleAuto(draft[row.field]) })); return; }
    }
    if (row.kind === 'status') {
      if (key.return || char === ' ') cycleStatus();
      return;
    }
    if (row.kind === 'session') {
      if (key.return && cardSession && onOpenSession) { flush(); onOpenSession(cardSession.id); }
      return;
    }
    if (row.kind === 'pinned') {
      if (key.return || char === ' ') setDraft((draft) => ({ ...draft, pinned: !draft.pinned }));
      return;
    }
    if (row.kind === 'archived') {
      if (key.return || char === ' ') setDraft((draft) => ({ ...draft, archived: !draft.archived }));
      return;
    }
    // Backspace on an EMPTY line removes it (the TextInput has nothing to
    // delete, so the key means the line itself).
    if ((key.backspace || key.delete) && row.kind === 'item' && !itemText(draftRef.current[row.list][row.index])) {
      setList(row.list, (value) => value.filter((_, j) => j !== row.index));
      setAt(Math.max(0, atRef.current - 1));
    }
  }, { isActive });

  const focusedKey = rowKey(row);
  const ref = (row: Row) => (node: DOMElement | null) => { if (node) rowRefs.current.set(rowKey(row), node); };
  const onFocused = (key: string) => isActive && focusedKey === key;

  /** The one live input, on whichever row holds focus. `columns` given =
   *  a prose row (a card's lines wrap, the arrows move through them); absent
   *  = a one-line field (the title). The card's chrome is the border (2), the
   *  padding (2) and the label gutter. */
  const input = (key: string, value: string, onChange: (value: string) => void, onSubmit: () => void, placeholder: string,
    columns?: number) =>
    onFocused(key)
      ? columns
        ? <TextArea value={value} onChange={onChange} onSubmit={onSubmit} placeholder={placeholder}
            columns={Math.max(1, columns)} onBoundary={(dir) => move(dir === 'up' ? -1 : 1)} />
        : <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder={placeholder} />
      // Prose reads whole whether or not it is being edited: a line that
      // wrapped while you typed it and then truncated on the way out was two
      // different lines. The title is one line either way.
      : value ? <Text wrap={columns ? 'wrap' : 'truncate'}>{value}</Text> : <Text dimColor>{placeholder}</Text>;

  const label = (text: string, key?: string) => (
    <Box width={13} flexShrink={0}>
      <Text color={key && focusedKey === key ? 'cyan' : undefined} dimColor={!(key && focusedKey === key)} bold={key ? focusedKey === key : false}>
        {key && focusedKey === key ? '❯ ' : '  '}{text}
      </Text>
    </Box>
  );

  const fieldRow = (field: 'title' | 'blocked' | 'resolution', name: string, placeholder: string, next: () => void) => (
    <Box ref={ref({ kind: 'field', field })}>
      {label(name, field)}
      {field === 'blocked' && draft.blocked && focusedKey !== field
        ? <Text color="red" wrap="wrap">{draft.blocked}</Text>
        : input(field, draft[field], (value) => setDraft((draft) => ({ ...draft, [field]: value })), next, placeholder,
          field === 'title' ? undefined : width - 4 - 13)}
    </Box>
  );

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="cyan" paddingX={1} overflow="hidden">
      <Box justifyContent="space-between">
        <Text bold color="cyan">{prefix}-{card.number}  <Text dimColor>{card.status.replace(/_/g, ' ')}</Text></Text>
        {saveState === 'saving' ? <Text color="yellow">saving…</Text>
          : saveState === 'saved' ? <Text color="green">saved ✓</Text>
          : saveState === 'failed' ? <Text color="red">save failed — edit to retry</Text>
          : <Text dimColor>auto-saves · esc closes</Text>}
      </Box>
      <Box ref={viewRef} flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} overflow="hidden">
      <Box ref={formRef} flexDirection="column" flexShrink={0} marginTop={-scroll}>
      <Box marginTop={1} flexDirection="column">
        {fieldRow('title', 'Title', 'the card, in a line', () => move(1))}
      </Box>
      <Box marginTop={1} ref={ref({ kind: 'status' })}>
        {label('Status', 'status')}
        <Text color={focusedKey === 'status' ? 'cyan' : undefined} dimColor={focusedKey !== 'status'}>
          {card.status.replace(/_/g, ' ')}
        </Text>
        {focusedKey === 'status' ? <Text dimColor> · [enter] next column</Text> : null}
      </Box>

      {SECTIONS.map(({ list, label: name, hint }) => {
        const items = draft[list] as (string | CardStep)[];
        return (
          <Box key={list} marginTop={1} flexDirection="column">
            <Box>
              {label(name, items.length === 0 ? `${list}+` : undefined)}
              {items.length === 0 ? (
                onFocused(`${list}+`)
                  ? <TextInput value="" placeholder={hint}
                      onChange={(value) => { setList(list, () => [newItem(list, value)]); }}
                      onSubmit={() => { setList(list, () => [newItem(list)]); }} />
                  : <Text dimColor>{hint}</Text>
              ) : tickable(list) ? <Text dimColor>{(items as CardStep[]).filter((step) => step.done).length}/{items.length}</Text> : null}
            </Box>
            {items.map((item, i) => {
              const key = `${list}:${i}`;
              return (
                <Box key={i} ref={ref({ kind: 'item', list, index: i })}>
                  <Box width={12} flexShrink={0} justifyContent="flex-end">
                    <Text color={focusedKey === key ? 'cyan' : undefined} dimColor={focusedKey !== key}>
                      {focusedKey === key ? '❯ ' : ''}{tickable(list)
                        ? ((item as CardStep).done ? '[x] ' : '[ ] ') : '  '}
                    </Text>
                  </Box>
                  {tickable(list) && (item as CardStep).done && focusedKey !== key
                    ? <Text color="green" wrap="wrap">{itemText(item)}</Text>
                    : input(key, itemText(item), (text) => setItem(list, i, text), () => insertBelow(list, i), '', width - 4 - 12)}
                </Box>
              );
            })}
          </Box>
        );
      })}
      {showBlocked(draft, card.status) && (
        <Box flexDirection="column" marginTop={1}>
          <Box>{fieldRow('blocked', 'Blocked', 'why it is blocked', () => move(1))}</Box>
          <Box>{fieldRow('resolution', 'Resolution', 'your reply — what resolves it', () => move(1))}</Box>
        </Box>
      )}
      {([
        ['auto_plan', 'Auto plan', store.state.autoPlanDefault, store.state.autoPlanSource],
        ['auto_build', 'Auto build', store.state.autoBuildDefault, store.state.autoBuildSource],
      ] as const).map(([field, name, fallback, source]) => (
        // Every card feature keeps a blank line above the next — same rhythm
        // as every other section of the page.
        <Box key={field} marginTop={1} ref={ref({ kind: 'auto', field })}>
          {label(name, field)}
          <Text color={(draft[field] ?? fallback) ? 'green' : undefined}
            dimColor={!(draft[field] ?? fallback)}>
            {autoLabel(draft[field], Boolean(fallback), source)}
          </Text>
          {focusedKey === field ? <Text dimColor> · [enter] card → on → off</Text> : null}
        </Box>
      ))}
      <Box marginTop={1} ref={ref({ kind: 'session' })}>
        {label('Session', 'session')}
        {cardSession
          ? <Text wrap="truncate" color={focusedKey === 'session' ? 'cyan' : undefined}>{cardSession.name ?? 'unnamed'}</Text>
          : <Text dimColor>none — appears when the looper runs the card</Text>}
        {cardSession && focusedKey === 'session' ? <Text dimColor> · [enter] opens</Text> : null}
      </Box>
      <Box marginTop={1} ref={ref({ kind: 'pinned' })}>
        {label('Pinned', 'pinned')}
        <Text dimColor={!draft.pinned} color={draft.pinned ? 'cyan' : undefined}>
          {draft.pinned ? 'yes — top of its column' : 'no'}
        </Text>
        {focusedKey === 'pinned' ? <Text dimColor> · [enter] toggles</Text> : null}
      </Box>
      <Box marginTop={1} ref={ref({ kind: 'archived' })}>
        {label('Archived', 'archived')}
        <Text dimColor={!draft.archived} color={draft.archived ? 'yellow' : undefined}>
          {draft.archived ? 'yes — off the board' : 'no'}
        </Text>
        {focusedKey === 'archived' ? <Text dimColor> · [enter] toggles</Text> : null}
      </Box>
      </Box>
      </Box>
      <Box marginTop={1} justifyContent="space-between">
        <Text dimColor wrap="truncate-end">[tab/↑↓] move · [enter] next line · [ctrl+e] tick · [esc] back</Text>
        {/* What the viewport hides, SelectList's wording. Pinned: the keys
            give way, never this. */}
        <Box flexShrink={0} marginLeft={1}>
          <Text dimColor>{[hidden.above ? `↑ ${hidden.above} more` : '', hidden.below ? `↓ ${hidden.below} more` : '']
            .filter(Boolean).join(' · ')}</Text>
        </Box>
      </Box>
    </Box>
  );
}
