// The kanban board — the left pane's alternate view (/kanban). Renders from
// the BoardStore and subscribes to it; every mutation goes through the store,
// which is also what the Assistant's `kanban` tool edits — one object, so a
// tool edit and a mouse edit repaint the same way. Mouse: click opens a card,
// press+move drags it (hit-testing via measureElement against the live
// layout, which in the alternate screen IS the viewport); events right of
// `width` belong to the voice pane and are ignored here.
import { Box, measureElement, useInput, type DOMElement } from 'ink';
import { Text } from './Text.js';
import Spinner from 'ink-spinner';
import { useEffect, useRef, useState } from 'react';
import { isMouseInput, parseMouse } from '../mouse.js';
import { CardEditor } from './CardEditor.js';
import type { BoardStore, Card } from '../board.js';
import { turnAgeColor, TURN_AGE_TICK_MS } from '../turnAge.js';

const HEADER_ROWS = 3; // column top border + header line + blank line, above the first card

interface Drag { cardId: number; toCol: string; toRow: number; moved: boolean }

export function Board({ store, width, height, isActive, onClose, card, onOpenCard, onCloseCard,
  onOpenSession, onArchived }: {
  store: BoardStore; width: number; height: number; isActive: boolean; onClose: () => void;
  /** The card whose editor is open, by seq. The window owns this: it also
   *  knows where esc leaves the editor, which is the only thing that ever
   *  differed between a card opened here and one opened from the chat. */
  card?: number;
  /** enter or a click on a card. The window opens it, marked as coming from
   *  the board, so esc comes back to these columns. */
  onOpenCard: (seq: number) => void;
  /** esc out of the editor — the window sends it back where it came from. */
  onCloseCard: () => void;
  /** The card editor's Session row — open that session in the chat view. */
  onOpenSession?: (id: string) => void;
  /** [a] — the /archived screen (a menu, so App leaves the board first). */
  onArchived?: () => void;
}) {
  const [, bump] = useState(0);
  useEffect(() => store.subscribe(() => bump((n) => n + 1)), [store]);
  // A running turn ages, so the board has to repaint even when nothing about
  // the card changed — the spinner's colour IS the warning, and without a tick
  // it would stay the colour it was born.
  useEffect(() => {
    const t = setInterval(() => bump((n) => n + 1), TURN_AGE_TICK_MS);
    return () => clearInterval(t);
  }, []);
  // One load at open; from then on the store's event stream keeps it current.
  useEffect(() => { void store.load(); }, [store]);

  const [focus, setFocus] = useState({ col: 0, row: 0 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  // [e]: the FOCUSED column alone, across the whole width — for reading
  // titles the narrow columns cut. A flag on the focus, not a column of its
  // own: ← → walk the expanded view between columns, and a card tabbed out
  // of it is followed, with no second selection to keep in step.
  const [zoom, setZoom] = useState(false);
  const colRefs = useRef(new Map<string, DOMElement>());
  // [a] archive confirmation — the killArmed/trashArmed pattern: first press
  // arms (shows the prompt), second press on the same card archives.
  const archiveArmed = useRef<number | null>(null);

  const { columns, prefix, loaded, workspace, error } = store.state;
  const focusColName = columns[Math.min(focus.col, Math.max(0, columns.length - 1))];
  const focusCards = focusColName ? store.cardsIn(focusColName) : [];
  const focusCard: Card | undefined = focusCards[Math.min(focus.row, focusCards.length - 1)];
  // The columns on screen — what renders AND what the mouse can hit (a ref
  // for a column not drawn is a stale node with stale geometry).
  const shown = zoom && focusColName ? [focusColName] : columns;

  const hit = (x: number, y: number): { col: string; row: number } | null => {
    if (x >= width) return null; // the voice pane's side of the screen
    for (const col of shown) {
      const node = colRefs.current.get(col);
      if (!node) continue;
      const m = measureElement(node);
      if (x >= m.x && x < m.x + m.width && y >= m.y && y < m.y + m.height)
        return { col, row: Math.max(0, y - m.y - HEADER_ROWS) };
    }
    return null;
  };

  const openEdit = (t: Card) => onOpenCard(t.seq);
  const clampRow = (ci: number, row: number) =>
    Math.max(0, Math.min(store.cardsIn(columns[ci]).length - 1, row));
  // A screen asked for from outside (the Assistant's "open card 7" / "expand
  // plan" / "show the board") — consumed once the board has data; before
  // that it waits.
  useEffect(() => {
    if (!store.state.loaded || store.requested == null) return;
    const req = store.consumeRequested();
    if (!req) return;
    if (req === 'board') { setZoom(false); return; }
    const ci = columns.indexOf(req.column);
    if (ci < 0) return;
    setZoom(true);
    setFocus((f) => ({ col: ci, row: clampRow(ci, f.row) }));
  });
  useInput((ch, key) => {
    // --- new-card title entry ---
    if (adding !== null) {
      if (key.return) {
        const title = adding.trim();
        if (title && focusColName) void store.create({ title, status: focusColName });
        setAdding(null);
      } else if (key.escape) setAdding(null);
      else if (key.backspace || key.delete) setAdding(adding.slice(0, -1));
      else if (ch && !key.ctrl && !key.meta) setAdding(adding + ch);
      return;
    }
    // --- mouse on the board ---
    if (isMouseInput(ch)) {
      const ev = parseMouse(ch);
      if (!ev) return;
      if (ev.kind === 'press' && ev.button === 0) {
        const h = hit(ev.x, ev.y);
        if (!h) return;
        const cards = store.cardsIn(h.col);
        const ci = columns.indexOf(h.col);
        if (h.row < cards.length) {
          setFocus({ col: ci, row: h.row });
          setDrag({ cardId: cards[h.row].id, toCol: h.col, toRow: h.row, moved: false });
        } else setFocus({ col: ci, row: Math.max(0, cards.length - 1) });
      } else if (ev.kind === 'drag' && drag) {
        const h = hit(ev.x, ev.y);
        setDrag(h ? { ...drag, toCol: h.col, toRow: h.row, moved: true } : { ...drag, moved: true });
      } else if (ev.kind === 'release' && drag) {
        if (drag.moved) {
          void store.move(drag.cardId, drag.toCol, drag.toRow);
          setFocus({ col: Math.max(0, columns.indexOf(drag.toCol)), row: drag.toRow });
        } else {
          const clicked = store.state.cards.find((t) => t.id === drag.cardId);
          if (clicked) openEdit(clicked);
        }
        setDrag(null);
      } else if (ev.kind === 'wheel') {
        setFocus((f) => ({ ...f, row: Math.max(0, Math.min(focusCards.length - 1, f.row + ev.button)) }));
      }
      return;
    }
    // --- keys ---
    // Any key that is not `a` or `c` disarms the archive confirmation —
    // cleared up front so every branch below gets a clean slate.
    const wasArmed = archiveArmed.current;
    if (ch !== 'a' && ch !== 'c') archiveArmed.current = null;
    // esc is one level back: armed → disarm; drag → columns; expanded → columns; columns → chat.
    if (key.escape) { if (wasArmed != null) { bump((n) => n + 1); } else if (drag) setDrag(null); else if (zoom) setZoom(false); else onClose(); return; }
    // Selection is the arrows alone (vim's h/l/j/k selection synonyms were
    // dropped — two ways to say the same thing made the footer unreadable);
    // tab/shift+tab move the card between columns, j/k (either case) within
    // its own.
    if (key.leftArrow) setFocus((f) => { const c = Math.max(0, f.col - 1); return { col: c, row: clampRow(c, f.row) }; });
    else if (key.rightArrow) setFocus((f) => { const c = Math.min(columns.length - 1, f.col + 1); return { col: c, row: clampRow(c, f.row) }; });
    else if (key.downArrow) setFocus((f) => ({ ...f, row: clampRow(f.col, f.row + 1) }));
    else if (key.upArrow) setFocus((f) => ({ ...f, row: clampRow(f.col, f.row - 1) }));
    // Card moves land at the END of the target column: the row passed to
    // move() must be the real index past the last card (move computes pos
    // from the neighbours at that row — a huge row finds none and falls
    // through to pos 1, the top, while the focus went to the bottom row and
    // sat on the wrong card).
    else if (key.tab && key.shift && focusCard && focus.col > 0) { const col = columns[focus.col - 1]; const end = store.cardsIn(col).length; void store.move(focusCard.id, col, end); setFocus((f) => ({ col: f.col - 1, row: end })); }
    else if (key.tab && !key.shift && focusCard && focus.col < columns.length - 1) { const col = columns[focus.col + 1]; const end = store.cardsIn(col).length; void store.move(focusCard.id, col, end); setFocus((f) => ({ col: f.col + 1, row: end })); }
    else if ((ch === 'j' || ch === 'J') && focusCard) { void store.move(focusCard.id, focusColName, focus.row + 2); setFocus((f) => ({ ...f, row: clampRow(f.col, f.row + 1) })); }
    else if ((ch === 'k' || ch === 'K') && focusCard && focus.row > 0) { void store.move(focusCard.id, focusColName, focus.row - 1); setFocus((f) => ({ ...f, row: f.row - 1 })); }
    else if (key.return && focusCard) openEdit(focusCard);
    else if (ch === 'n') setAdding('');
    else if (ch === 'p' && focusCard) void store.update(focusCard.id, { pinned: !focusCard.pinned });
    else if (ch === 'a' && focusCard && wasArmed == null) {
      archiveArmed.current = focusCard.id; bump((n) => n + 1);
    }
    else if (ch === 'c' && focusCard && wasArmed === focusCard.id) {
      archiveArmed.current = null;
      void store.update(focusCard.id, { archived: true });
      setFocus((f) => ({ ...f, row: clampRow(f.col, f.row) }));
    }
    else if (ch === 'e' && focusColName) setZoom((z) => !z);
    else if (ch === 'v') onArchived?.();
  }, { isActive: isActive && card === undefined });

  const dragging = drag?.moved ? store.state.cards.find((t) => t.id === drag.cardId) : undefined;

  // ONE card-editor path, however the card was opened. esc is onCloseCard,
  // and the window decides where that lands.
  if (card !== undefined) {
    if (!loaded) return null;   // no column flash while the data loads
    const open = store.bySeq(card);
    if (!open) { onCloseCard(); return null; }
    return (
      <CardEditor key={open.id} store={store} card={open} width={width} height={height}
        prefix={prefix} isActive={isActive} onClose={onCloseCard} onOpenSession={onOpenSession} />
    );
  }

  const cards = store.state.cards.filter((t) => !t.archived).length;
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box paddingX={1} justifyContent="space-between">
        <Text bold color="cyan">{prefix}<Text dimColor> · {workspace ?? store.workspaceId}</Text></Text>
        <Text dimColor>{cards} card{cards === 1 ? '' : 's'}</Text>
      </Box>
      <Box flexGrow={1}>
        {shown.map((col) => {
          const ci = columns.indexOf(col);
          const cards = store.cardsIn(col);
          const isTarget = dragging && drag!.toCol === col;
          return (
            <Box key={col} ref={(n) => { if (n) colRefs.current.set(col, n); }}
              flexDirection="column" flexGrow={1} flexBasis={0}
              borderStyle="round" borderColor={isTarget ? 'green' : ci === focus.col ? 'cyan' : 'gray'}
              paddingX={1} overflow="hidden">
              <Text bold color={ci === focus.col ? 'cyan' : undefined}>
                {col.replace(/_/g, ' ')} <Text dimColor>({cards.length})</Text>
              </Text>
              <Text> </Text>
              {cards.map((t, ri) => {
                const ghostHere = isTarget && ri === Math.min(drag!.toRow, cards.length - 1) && t.id !== dragging.id;
                // The whole row is the title: a blocked card is just red, card
                // progress lives on the edit page — no suffixes eating width.
                // The two-cell gutter: the drag ghost's ▸ first, else a
                // spinner when the card's session is actively running, else a
                // colored • for the git work state (red/yellow/green).
                const lockedSince = store.state.cardLocked?.[t.seq];
                const locked = lockedSince != null;
                const spinColor = turnAgeColor(lockedSince);
                const work = store.state.cardWork?.[t.seq];
                const WORK_COLOR: Record<string, string> = { not_pushed: 'red', not_merged: 'yellow', merged: 'green' };
                const dotColor = work ? WORK_COLOR[work] : undefined;
                const selected = ci === focus.col && ri === focus.row && !dragging;
                return (
                  <Text key={t.id} wrap="truncate"
                    inverse={selected}
                    dimColor={dragging?.id === t.id}
                    color={ghostHere ? 'green' : t.blocked_reason ? 'red' : undefined}>
                    {ghostHere ? '▸ ' : locked
                      ? <><Text color={spinColor}><Spinner type="dots" /></Text>{' '}</>
                      : dotColor
                        ? <><Text color={dotColor} inverse={selected}>{'•'}</Text>{' '}</>
                        : '  '}{t.seq}-{t.title}{t.pinned ? ' 📌' : ''}
                  </Text>
                );
              })}
              {isTarget && drag!.toRow >= cards.length && <Text color="green">{`▸ ${dragging.title}`}</Text>}
            </Box>
          );
        })}
        {columns.length === 0 && <Text dimColor>{error ? `board error: ${error}` : loaded ? 'no columns' : 'loading board…'}</Text>}
      </Box>
      {/* The help wraps to as many rows as the width needs — the columns
          above shrink to make room; the other two states are one line. */}
      <Box paddingX={1} flexShrink={0}>
        {adding !== null ? (
          <Text>new card in {focusColName?.replace(/_/g, ' ')}: <Text inverse>{adding || ' '}</Text><Text dimColor>  (enter to add, esc to cancel)</Text></Text>
        ) : dragging ? (
          <Text color="green">moving #{dragging.seq} → {drag!.toCol.replace(/_/g, ' ')} (release to drop, esc to cancel)</Text>
        ) : archiveArmed.current != null && focusCard ? (
          <Text color="yellow">archive #{focusCard.seq}-{focusCard.title}? [c] to confirm, [esc] to cancel</Text>
        ) : (
          <Text dimColor>↑ ↓ ← →  [esc]  [enter] open  [tab/shift+tab] move  [j/k] sort  [n]ew  [p]in  [a]rchive  {zoom ? '[e] collapse' : '[e]xpand'}  [v]iew archived</Text>
        )}
      </Box>
    </Box>
  );
}
