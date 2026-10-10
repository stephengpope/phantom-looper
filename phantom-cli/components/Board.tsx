// The kanban board — the left pane's alternate view (/kanban). Renders from
// the BoardStore and subscribes to it; every mutation goes through the store,
// which is also what the Assistant's `kanban` tool edits — one object, so a
// tool edit and a mouse edit repaint the same way. Mouse: click opens a card,
// press+move drags it (hit-testing via measureElement against the live
// layout, which in the alternate screen IS the viewport); events right of
// `width` belong to the voice pane and are ignored here.
import { Box, measureElement, type DOMElement } from 'ink';
import { useInput } from './useInput.js';
import { Text } from './Text.js';
import Spinner from 'ink-spinner';
import { useEffect, useRef, useState } from 'react';
import { isMouseInput, parseMouse } from '../mouse.js';
import { CardEditor } from './CardEditor.js';
import type { BoardStore, Card } from '../board.js';
import { STATUS_ICON } from './Launcher.js';
import { turnAgeColor, TURN_AGE_TICK_MS } from '../turnAge.js';

const HEADER_ROWS = 3; // column top border + header line + blank line, above the first card

interface Drag { cardId: number; toCol: string; toRow: number; moved: boolean }

export function Board({ store, width, height, isActive, onClose, card, confirm, onOpenCard, onCloseCard,
  onOpenSession, onArchived }: {
  store: BoardStore; width: number; height: number; isActive: boolean; onClose: () => void;
  /** THE yes/no (the window's dialog) — [a] asks through it before archiving. */
  confirm: (title: string, message?: string) => Promise<boolean>;
  /** The card whose editor is open, by number. The window owns this: it also
   *  knows where esc leaves the editor, which is the only thing that ever
   *  differed between a card opened here and one opened from the chat. */
  card?: number;
  /** enter or a click on a card. The window opens it, marked as coming from
   *  the board, so esc comes back to these columns. */
  onOpenCard: (number: number) => void;
  /** esc out of the editor — the window sends it back where it came from. */
  onCloseCard: () => void;
  /** The card editor's Session row — open that session in the chat view. */
  onOpenSession?: (id: string) => void;
  /** [a] — the /archived screen (a menu, so App leaves the board first). */
  onArchived?: () => void;
}) {
  const [, bump] = useState(0);
  useEffect(() => store.subscribe(() => bump((tick) => tick + 1)), [store]);
  // A running turn ages, so the board has to repaint even when nothing about
  // the card changed — the spinner's colour IS the warning, and without a tick
  // it would stay the colour it was born.
  useEffect(() => {
    const timer = setInterval(() => bump((tick) => tick + 1), TURN_AGE_TICK_MS);
    return () => clearInterval(timer);
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

  const { columns, prefix, loaded, project, error } = store.state;
  const focusColName = columns[Math.min(focus.col, Math.max(0, columns.length - 1))];
  const focusCards = focusColName ? store.cardsIn(focusColName) : [];
  const focusCard: Card | undefined = focusCards[Math.min(focus.row, focusCards.length - 1)];
  // The columns on screen — what renders AND what the mouse can hit (a ref
  // for a column not drawn is a stale node with stale geometry).
  const shown = zoom && focusColName ? [focusColName] : columns;

  const hit = (column: number, row: number): { col: string; row: number } | null => {
    if (column >= width) return null; // the voice pane's side of the screen
    for (const col of shown) {
      const node = colRefs.current.get(col);
      if (!node) continue;
      const measured = measureElement(node);
      if (column >= measured.x && column < measured.x + measured.width && row >= measured.y && row < measured.y + measured.height)
        return { col, row: Math.max(0, row - measured.y - HEADER_ROWS) };
    }
    return null;
  };

  const openEdit = (card: Card) => onOpenCard(card.number);
  const clampRow = (columnIndex: number, row: number) =>
    Math.max(0, Math.min(store.cardsIn(columns[columnIndex]).length - 1, row));
  // A screen asked for from outside (the Assistant's "open card 7" / "expand
  // plan" / "show the board") — consumed once the board has data; before
  // that it waits.
  useEffect(() => {
    if (!store.state.loaded || store.requested == null) return;
    const req = store.consumeRequested();
    if (!req) return;
    if (req === 'board') { setZoom(false); return; }
    const columnIndex = columns.indexOf(req.column);
    if (columnIndex < 0) return;
    setZoom(true);
    setFocus((focus) => ({ col: columnIndex, row: clampRow(columnIndex, focus.row) }));
  });
  useInput((char, key) => {
    // --- new-card title entry ---
    if (adding !== null) {
      if (key.return) {
        const title = adding.trim();
        if (title && focusColName) void store.create({ title, status: focusColName });
        setAdding(null);
      } else if (key.escape) setAdding(null);
      else if (key.backspace || key.delete) setAdding(adding.slice(0, -1));
      else if (char && !key.ctrl && !key.meta) setAdding(adding + char);
      return;
    }
    // --- mouse on the board ---
    if (isMouseInput(char)) {
      const mouse = parseMouse(char);
      if (!mouse) return;
      if (mouse.type === 'press' && mouse.button === 0) {
        const hitAt = hit(mouse.x, mouse.y);
        if (!hitAt) return;
        const cards = store.cardsIn(hitAt.col);
        const columnIndex = columns.indexOf(hitAt.col);
        if (hitAt.row < cards.length) {
          setFocus({ col: columnIndex, row: hitAt.row });
          setDrag({ cardId: cards[hitAt.row].id, toCol: hitAt.col, toRow: hitAt.row, moved: false });
        } else setFocus({ col: columnIndex, row: Math.max(0, cards.length - 1) });
      } else if (mouse.type === 'drag' && drag) {
        const hitAt = hit(mouse.x, mouse.y);
        setDrag(hitAt ? { ...drag, toCol: hitAt.col, toRow: hitAt.row, moved: true } : { ...drag, moved: true });
      } else if (mouse.type === 'release' && drag) {
        if (drag.moved) {
          void store.move(drag.cardId, drag.toCol, drag.toRow);
          setFocus({ col: Math.max(0, columns.indexOf(drag.toCol)), row: drag.toRow });
        } else {
          const clicked = store.state.cards.find((card) => card.id === drag.cardId);
          if (clicked) openEdit(clicked);
        }
        setDrag(null);
      } else if (mouse.type === 'wheel') {
        setFocus((focus) => ({ ...focus, row: Math.max(0, Math.min(focusCards.length - 1, focus.row + mouse.button)) }));
      }
      return;
    }
    // --- keys ---
    // esc is one level back: drag → columns; expanded → columns; columns → chat.
    if (key.escape) { if (drag) setDrag(null); else if (zoom) setZoom(false); else onClose(); return; }
    // Selection is the arrows alone (vim's h/l/j/k selection synonyms were
    // dropped — two ways to say the same thing made the footer unreadable);
    // tab/shift+tab move the card between columns, j/k (either case) within
    // its own.
    if (key.leftArrow) setFocus((focus) => { const column = Math.max(0, focus.col - 1); return { col: column, row: clampRow(column, focus.row) }; });
    else if (key.rightArrow) setFocus((focus) => { const column = Math.min(columns.length - 1, focus.col + 1); return { col: column, row: clampRow(column, focus.row) }; });
    else if (key.downArrow) setFocus((focus) => ({ ...focus, row: clampRow(focus.col, focus.row + 1) }));
    else if (key.upArrow) setFocus((focus) => ({ ...focus, row: clampRow(focus.col, focus.row - 1) }));
    // Card moves land at the END of the target column: the row passed to
    // move() must be the real index past the last card (move computes pos
    // from the neighbours at that row — a huge row finds none and falls
    // through to pos 1, the top, while the focus went to the bottom row and
    // sat on the wrong card).
    else if (key.tab && key.shift && focusCard && focus.col > 0) { const col = columns[focus.col - 1]; const end = store.cardsIn(col).length; void store.move(focusCard.id, col, end); setFocus((focus) => ({ col: focus.col - 1, row: end })); }
    else if (key.tab && !key.shift && focusCard && focus.col < columns.length - 1) { const col = columns[focus.col + 1]; const end = store.cardsIn(col).length; void store.move(focusCard.id, col, end); setFocus((focus) => ({ col: focus.col + 1, row: end })); }
    else if ((char === 'j' || char === 'J') && focusCard) { void store.move(focusCard.id, focusColName, focus.row + 2); setFocus((focus) => ({ ...focus, row: clampRow(focus.col, focus.row + 1) })); }
    else if ((char === 'k' || char === 'K') && focusCard && focus.row > 0) { void store.move(focusCard.id, focusColName, focus.row - 1); setFocus((focus) => ({ ...focus, row: focus.row - 1 })); }
    else if (key.return && focusCard) openEdit(focusCard);
    else if (char === 'n') setAdding('');
    else if (char === 'p' && focusCard) void store.update(focusCard.id, { pinned: !focusCard.pinned });
    else if (char === 'a' && focusCard) {
      const card = focusCard;
      void confirm(`archive #${card.number} ${card.title}?`, '[v] shows archived cards; [r] there restores it').then((yes) => {
        if (!yes) return;
        void store.update(card.id, { archived: true });
        setFocus((focus) => ({ ...focus, row: clampRow(focus.col, focus.row) }));
      });
    }
    else if (char === 'e' && focusColName) setZoom((zoomed) => !zoomed);
    else if (char === 'v') onArchived?.();
  }, { isActive: isActive && card === undefined });

  const dragging = drag?.moved ? store.state.cards.find((card) => card.id === drag.cardId) : undefined;

  // ONE card-editor path, however the card was opened. esc is onCloseCard,
  // and the window decides where that lands. A card that is not on the
  // board (archived elsewhere, a bad number) closes its editor — from an
  // effect, not mid-render: closing repaints the window, and React refuses
  // a state change while it is drawing this component.
  const gone = card !== undefined && loaded && !store.byNumber(card);
  useEffect(() => { if (gone) onCloseCard(); }, [gone]);
  if (card !== undefined) {
    if (!loaded) return null;   // no column flash while the data loads
    const open = store.byNumber(card);
    if (!open) return null;
    return (
      <CardEditor key={open.id} store={store} card={open} width={width} height={height}
        prefix={prefix} isActive={isActive} onClose={onCloseCard} onOpenSession={onOpenSession} />
    );
  }

  const cards = store.state.cards.filter((card) => !card.archived).length;
  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box paddingX={1} justifyContent="space-between">
        <Text bold color="cyan">{prefix}<Text dimColor> · {project ?? store.projectId}</Text></Text>
        <Text dimColor>{cards} card{cards === 1 ? '' : 's'}</Text>
      </Box>
      <Box flexGrow={1}>
        {shown.map((col) => {
          const columnIndex = columns.indexOf(col);
          const cards = store.cardsIn(col);
          const isTarget = dragging && drag!.toCol === col;
          return (
            <Box key={col} ref={(node) => { if (node) colRefs.current.set(col, node); }}
              flexDirection="column" flexGrow={1} flexBasis={0}
              borderStyle="round" borderColor={isTarget ? 'green' : columnIndex === focus.col ? 'cyan' : 'gray'}
              paddingX={1} overflow="hidden">
              <Text bold color={columnIndex === focus.col ? 'cyan' : undefined}>
                {STATUS_ICON[col]
                  ? <><Text color={STATUS_ICON[col].color}>{STATUS_ICON[col].char}</Text>{' '}</>
                  : null}
                {col.replace(/_/g, ' ')} <Text dimColor>({cards.length})</Text>
              </Text>
              <Text> </Text>
              {cards.map((card, rowIndex) => {
                const ghostHere = isTarget && rowIndex === Math.min(drag!.toRow, cards.length - 1) && card.id !== dragging.id;
                // The whole row is the title: a blocked card is just red, card
                // progress lives on the edit page — no suffixes eating width.
                // The two-cell gutter: the drag ghost's ▸ first, else a
                // spinner when the card's session is actively running, else a
                // colored • for the git work state (red/yellow/green).
                const lockedSince = store.state.cardLocked?.[card.number];
                const locked = lockedSince != null;
                const spinColor = turnAgeColor(lockedSince);
                const work = store.state.cardWorkState?.[card.number];
                const WORK_COLOR: Record<string, string> = { not_pushed: 'red', not_merged: 'yellow', merged: 'green' };
                const dotColor = work ? WORK_COLOR[work] : undefined;
                const selected = columnIndex === focus.col && rowIndex === focus.row && !dragging;
                return (
                  <Text key={card.id} wrap="truncate"
                    inverse={selected}
                    dimColor={dragging?.id === card.id}
                    color={ghostHere ? 'green' : card.blocked_reason ? 'red' : undefined}>
                    {ghostHere ? '▸ ' : locked
                      ? <><Text color={spinColor}><Spinner type="dots" /></Text>{' '}</>
                      : dotColor
                        ? <><Text color={dotColor} inverse={selected}>{'•'}</Text>{' '}</>
                        : '  '}{card.number}-{card.title}{card.pinned ? ' 📌' : ''}
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
          <Text color="green">moving #{dragging.number} → {drag!.toCol.replace(/_/g, ' ')} (release to drop, esc to cancel)</Text>
        ) : (
          <Text dimColor>↑ ↓ ← →  [esc]  [enter] open  [tab/shift+tab] move  [j/k] sort  [n]ew  [p]in  [a]rchive  {zoom ? '[e] collapse' : '[e]xpand'}  [v]iew archived</Text>
        )}
      </Box>
    </Box>
  );
}
