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
// user's text.
import { Box, measureElement, useInput, type DOMElement } from 'ink';
import { Text } from './Text.js';
import { useEffect, useRef, useState } from 'react';
import { isMouseInput, parseMouse } from '../mouse.js';
import { TextInput } from './TextInput.js';
import { newKey } from '../../core/kanban.js';
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
  title: string; user_story: string; blocked: string; resolution: string;
  pinned: boolean; archived: boolean;
  auto_plan: boolean | null;
  auto_build: boolean | null;
  details: string[];
  requirements: CardStep[];
}

/** Each per-card switch cycles inherit → on → off (null = the workspace's
 *  setting of the same name decides). */
export const cycleAuto = (v: boolean | null): boolean | null =>
  v === null ? true : v === true ? false : null;

/** An Auto row's text: the EFFECTIVE value first, its source after — a card
 *  is opened to learn whether the looper will run it, so the answer never
 *  hides behind "inherit". */
export function autoLabel(v: boolean | null, fallback: boolean, source?: string): string {
  if (v !== null) return `${v ? 'on' : 'off'} · this card`;
  return `${fallback ? 'on' : 'off'} · ${source === 'workspace' ? 'workspace' : source === 'global' ? 'global' : 'default'}`;
}

/** Lists whose lines carry a done box — ctrl+t (or clicking the box) ticks. */
const tickable = (list: ListName) => list === 'requirements';

type Row =
  | { kind: 'field'; field: 'title' | 'user_story' | 'blocked' | 'resolution' }
  | { kind: 'item'; list: ListName; index: number }
  | { kind: 'empty'; list: ListName }
  | { kind: 'pinned' }
  | { kind: 'archived' }
  | { kind: 'auto'; field: AutoField }
  | { kind: 'session' };

const rowKey = (r: Row) =>
  r.kind === 'field' ? r.field : r.kind === 'archived' ? 'archived'
  : r.kind === 'pinned' ? 'pinned'
  : r.kind === 'session' ? 'session'
  : r.kind === 'auto' ? r.field
  : r.kind === 'empty' ? `${r.list}+` : `${r.list}:${r.index}`;

/** Blocked is the STATUS — the reason row shows only for cards in the
 *  blocked column, where typing the why is the point. */
const showBlocked = (_d: Draft, status: string) => status === 'blocked';

function buildRows(d: Draft, status: string): Row[] {
  const rows: Row[] = [{ kind: 'field', field: 'title' }, { kind: 'field', field: 'user_story' }];
  for (const { list } of SECTIONS) {
    const n = d[list].length;
    if (n === 0) rows.push({ kind: 'empty', list });
    else for (let i = 0; i < n; i++) rows.push({ kind: 'item', list, index: i });
  }
  if (showBlocked(d, status)) rows.push({ kind: 'field', field: 'blocked' }, { kind: 'field', field: 'resolution' });
  // The loop block reads cause before effect: the two switches that decide
  // whether the looper runs this card, then the session that running it made.
  // Archived stays the bottom row; Pinned sits directly above it.
  rows.push({ kind: 'auto', field: 'auto_plan' }, { kind: 'auto', field: 'auto_build' },
    { kind: 'session' },
    { kind: 'pinned' }, { kind: 'archived' });
  return rows;
}

const itemText = (v: string | CardStep): string => typeof v === 'string' ? v : v.text;

const toDraft = (t: Card): Draft => ({
  title: t.title, user_story: t.user_story, blocked: t.blocked_reason ?? '', resolution: t.resolution ?? '',
  pinned: t.pinned, archived: t.archived, auto_plan: t.auto_plan ?? null, auto_build: t.auto_build ?? null,
  details: t.details ? t.details.split('\n') : [],
  requirements: t.requirements.map((c) => ({ ...c })),
});

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What the server does not yet have — every value CANONICAL (title trimmed,
 *  empty checklist lines dropped), so a flushed draft diffs to nothing and the
 *  debounce goes quiet instead of re-sending trim artifacts forever. */
function diffPatch(d: Draft, c: Card): CardPatch {
  const patch: CardPatch = {};
  const title = d.title.trim();
  if (title && title !== c.title) patch.title = title;
  if (d.user_story !== c.user_story) patch.user_story = d.user_story;
  const details = d.details.join('\n').replace(/\n+$/, '');
  if (details !== c.details) patch.details = details;
  const blocked = d.blocked.trim() || null;
  if (blocked !== c.blocked_reason) patch.blocked_reason = blocked;
  const resolution = d.resolution.trim() || null;
  if (resolution !== (c.resolution ?? null)) patch.resolution = resolution;
  {
    // Both sides through ONE shape: `same` is JSON.stringify, so a field the
    // draft and the server spell in a different ORDER would read as a change
    // and re-arm the debounce forever.
    const canon = (s: CardStep): CardStep => ({ key: s.key, text: s.text.trim(), done: s.done });
    const v = d.requirements.map(canon).filter((s) => s.text);
    if (!same(v, c.requirements.map(canon))) patch.requirements = v;
  }
  if (d.pinned !== c.pinned) patch.pinned = d.pinned;
  if (d.archived !== c.archived) patch.archived = d.archived;
  if (d.auto_plan !== (c.auto_plan ?? null)) patch.auto_plan = d.auto_plan;
  if (d.auto_build !== (c.auto_build ?? null)) patch.auto_build = d.auto_build;
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
    setDraft((d) => {
      const merged = { ...d };
      for (const k of Object.keys(next) as (keyof Draft)[])
        if (same(d[k], seed[k])) (merged as Record<keyof Draft, unknown>)[k] = next[k];
      return merged;
    });
  }, [card]);
  // Focus lives in a ref and is READ from the ref (see the header comment).
  const atRef = useRef(0);
  const [, bump] = useState(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const rowRefs = useRef(new Map<string, DOMElement>());

  // The current loop's coding session, off the board payload — by seq, so a
  // refresh replacing the card objects cannot orphan it.
  const cardSession = store.state.sessions?.[card.seq];

  const rows = buildRows(draft, card.status);
  const at = Math.min(atRef.current, rows.length - 1);
  const row = rows[at];
  const setAt = (i: number) => { atRef.current = i; bump((n) => n + 1); };
  const move = (d: number) => {
    const n = buildRows(draftRef.current, card.status).length;
    setAt((Math.min(atRef.current, n - 1) + d + n) % n);
  };

  const setList = (list: ListName, fn: (v: (string | CardStep)[]) => (string | CardStep)[]) =>
    setDraft((dr) => ({ ...dr, [list]: fn(dr[list] as (string | CardStep)[]) }));
  // A checklist item is keyed HERE, not by the server. A keyless item comes
  // back from a save wearing a server-minted key, which the draft (mid-edit,
  // so never rebased) can never learn — the diff would never close, pinning
  // the corner on "saving…" and PATCHing every debounce for as long as the
  // editor stayed open. Keys are the card's own namespace, so uniqueness is
  // checked against the list in hand and the server's re-id path never fires.
  const newItem = (list: ListName, text = '', taken: (string | CardStep)[] = []): string | CardStep => {
    if (!tickable(list)) return text;
    const used = new Set(taken.map((x) => typeof x === 'string' ? '' : x.key));
    let key = newKey();
    while (used.has(key)) key = newKey();
    return { key, text, done: false };
  };
  const setItem = (list: ListName, index: number, text: string) =>
    setList(list, (v) => v.map((x, j) => j === index
      ? (typeof x === 'string' ? text : { ...x, text }) : x));
  const toggle = (list: ListName, index: number) =>
    setList(list, (v) => v.map((x, j) => j === index ? { ...(x as CardStep), done: !(x as CardStep).done } : x));
  const insertBelow = (list: ListName, index: number) => {
    setList(list, (v) => [...v.slice(0, index + 1), newItem(list, '', v), ...v.slice(index + 1)]);
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
      const server = store.state.cards.find((t) => t.id === id);
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
        setSaveState((s) => s !== 'saving' ? s : failedRef.current === sent ? 'failed' : 'saved');
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      return;
    }
    setSaveState('saving');
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => flushRef.current(), SAVE_DEBOUNCE_MS);
  }, [draft, card]);
  useEffect(() => () => { flushRef.current(); }, []);

  // Structure keys only — every text key belongs to the focused TextInput.
  useInput((ch, key) => {
    const rowsNow = buildRows(draftRef.current, card.status);
    const r = rowsNow[Math.min(atRef.current, rowsNow.length - 1)];
    if (isMouseInput(ch)) {
      const ev = parseMouse(ch);
      if (ev?.kind !== 'press' || ev.button !== 0 || ev.x >= width) return;
      for (let i = 0; i < rowsNow.length; i++) {
        const node = rowRefs.current.get(rowKey(rowsNow[i]));
        if (!node) continue;
        const m = measureElement(node);
        if (ev.x >= m.x && ev.x < m.x + m.width && ev.y >= m.y && ev.y < m.y + m.height) {
          const hitRow = rowsNow[i];
          setAt(i);
          if (hitRow.kind === 'archived') setDraft((d) => ({ ...d, archived: !d.archived }));
          if (hitRow.kind === 'pinned') setDraft((d) => ({ ...d, pinned: !d.pinned }));
          if (hitRow.kind === 'auto') setDraft((d) => ({ ...d, [hitRow.field]: cycleAuto(d[hitRow.field]) }));
          if (hitRow.kind === 'session' && cardSession && onOpenSession) { flush(); onOpenSession(cardSession.id); }
          // The [ ] box renders right-justified inside the 12-column label
          // gutter — a click anywhere in that gutter ticks; on the text, it
          // just focuses.
          if (hitRow.kind === 'item' && tickable(hitRow.list) && ev.x < m.x + 13) toggle(hitRow.list, hitRow.index);
          return;
        }
      }
      return;
    }
    if (key.escape) { flush(); onClose(); return; }
    if (key.tab || key.downArrow) { move(key.shift ? -1 : 1); return; }
    if (key.upArrow) { move(-1); return; }
    // ctrl+e — measured with `npm run keys` on the user's terminal, which
    // delivers only ctrl+e r l f d n v; t/k/y are eaten. ctrl+t kept as a
    // silent extra for terminals that do pass it.
    if (key.ctrl && (ch === 'e' || ch === 't') && r.kind === 'item' && tickable(r.list)) { toggle(r.list, r.index); return; }
    if (r.kind === 'auto') {
      if (key.return || ch === ' ') { setDraft((d) => ({ ...d, [r.field]: cycleAuto(d[r.field]) })); return; }
    }
    if (r.kind === 'session') {
      if (key.return && cardSession && onOpenSession) { flush(); onOpenSession(cardSession.id); }
      return;
    }
    if (r.kind === 'pinned') {
      if (key.return || ch === ' ') setDraft((d) => ({ ...d, pinned: !d.pinned }));
      return;
    }
    if (r.kind === 'archived') {
      if (key.return || ch === ' ') setDraft((d) => ({ ...d, archived: !d.archived }));
      return;
    }
    // Backspace on an EMPTY line removes it (the TextInput has nothing to
    // delete, so the key means the line itself).
    if ((key.backspace || key.delete) && r.kind === 'item' && !itemText(draftRef.current[r.list][r.index])) {
      setList(r.list, (v) => v.filter((_, j) => j !== r.index));
      setAt(Math.max(0, atRef.current - 1));
    }
  }, { isActive });

  const focusedKey = rowKey(row);
  const ref = (r: Row) => (n: DOMElement | null) => { if (n) rowRefs.current.set(rowKey(r), n); };
  const onFocused = (k: string) => isActive && focusedKey === k;

  /** The one live input, on whichever row holds focus. */
  const input = (k: string, value: string, onChange: (v: string) => void, onSubmit: () => void, placeholder: string) =>
    onFocused(k)
      ? <TextInput value={value} onChange={onChange} onSubmit={onSubmit} placeholder={placeholder} />
      : value ? <Text wrap="truncate">{value}</Text> : <Text dimColor>{placeholder}</Text>;

  const label = (text: string, k?: string) => (
    <Box width={13} flexShrink={0}>
      <Text color={k && focusedKey === k ? 'cyan' : undefined} dimColor={!(k && focusedKey === k)} bold={k ? focusedKey === k : false}>
        {k && focusedKey === k ? '❯ ' : '  '}{text}
      </Text>
    </Box>
  );

  const fieldRow = (field: 'title' | 'user_story' | 'blocked' | 'resolution', name: string, placeholder: string, next: () => void) => (
    <Box ref={ref({ kind: 'field', field })}>
      {label(name, field)}
      {field === 'blocked' && draft.blocked && focusedKey !== field
        ? <Text color="red" wrap="truncate">{draft.blocked}</Text>
        : input(field, draft[field], (v) => setDraft((d) => ({ ...d, [field]: v })), next, placeholder)}
    </Box>
  );

  return (
    <Box flexDirection="column" width={width} height={height} borderStyle="round" borderColor="cyan" paddingX={1} overflow="hidden">
      <Box justifyContent="space-between">
        <Text bold color="cyan">{prefix}-{card.seq}  <Text dimColor>{card.status.replace(/_/g, ' ')}</Text></Text>
        {saveState === 'saving' ? <Text color="yellow">saving…</Text>
          : saveState === 'saved' ? <Text color="green">saved ✓</Text>
          : saveState === 'failed' ? <Text color="red">save failed — edit to retry</Text>
          : <Text dimColor>auto-saves · esc closes</Text>}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {fieldRow('title', 'Title', 'the card, in a line', () => move(1))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {fieldRow('user_story', 'Story', 'as a …, I want …, so that …', () => move(1))}
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
                      onChange={(v) => { setList(list, () => [newItem(list, v)]); }}
                      onSubmit={() => { setList(list, () => [newItem(list)]); }} />
                  : <Text dimColor>{hint}</Text>
              ) : tickable(list) ? <Text dimColor>{(items as CardStep[]).filter((c) => c.done).length}/{items.length}</Text> : null}
            </Box>
            {items.map((v, i) => {
              const k = `${list}:${i}`;
              return (
                <Box key={i} ref={ref({ kind: 'item', list, index: i })}>
                  <Box width={12} flexShrink={0} justifyContent="flex-end">
                    <Text color={focusedKey === k ? 'cyan' : undefined} dimColor={focusedKey !== k}>
                      {focusedKey === k ? '❯ ' : ''}{tickable(list)
                        ? ((v as CardStep).done ? '[x] ' : '[ ] ') : '  '}
                    </Text>
                  </Box>
                  {tickable(list) && (v as CardStep).done && focusedKey !== k
                    ? <Text color="green" wrap="truncate">{itemText(v)}</Text>
                    : input(k, itemText(v), (t) => setItem(list, i, t), () => insertBelow(list, i), '')}
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
      <Box flexGrow={1} />
      <Box marginTop={1}>
        <Text dimColor>[tab/↑↓] move · [enter] next line · [ctrl+e] tick · [esc] back</Text>
      </Box>
    </Box>
  );
}
