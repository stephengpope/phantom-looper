// /archived — the project's archived cards, /resume's shape: a Screen page,
// one aligned table, newest change first (the server's order — fetched and
// paged by App, never part of the board download), the hint block reading
// the highlighted card's story. Where an accidental [a] on the board is
// taken back and closed work is browsed. Restore is the same archived:false
// PATCH the card editor's Archived row sends — the card returns to the
// column it was archived from (the `was in` column), which can wake the
// looper on a loop column with its auto switch on.
import { Screen } from './Screen.js';
import { SelectList, type Choice } from './SelectList.js';
import { tableChoices, type TableRow } from './table.js';
import { ago } from './Launcher.js';
import type { Card } from '../board.js';

/** Rows for the archive table — the board's own row shape (`<number>-<title>`),
 *  then the column it was archived from and when. No archived_at column
 *  exists; updated_at is the proxy (archiving touches it, and an archived
 *  card is rarely edited after). */
export function archivedChoices(cards: Card[], now = Date.now()): Choice<Card | null>[] {
  if (!cards.length) return [{ value: null, heading: true, label: 'nothing archived — [a] on the board archives a card' }];
  const rows = cards.map((card): TableRow<Card> => ({
    value: card,
    cells: [`${card.number}-${card.title}`, card.status.replace(/_/g, ' '), ago(card.updated_at, now)],
    hint: card.details || undefined,
  }));
  return tableChoices('card', [{ title: 'was in' }, { title: 'when' }], rows);
}

export function Archived({ cards, total, notice, onOpen, onRestore, onCancel, onNearEnd }: {
  cards: Card[];
  /** The whole archive's size — `cards` is the pages loaded so far. */
  total?: number;
  notice?: string;
  /** Open the card's editor (the solo view; esc from there is chat). */
  onOpen: (card: Card) => void;
  onRestore: (card: Card) => void;
  onCancel: () => void;
  /** The cursor neared the bottom — fetch the next page (SelectList's
   *  onNearEnd, passed straight through — /resume's lazy-list shape). */
  onNearEnd?: () => void;
}) {
  return (
    <Screen title="archived" notice={notice}
      footer={[
        { key: 'enter', does: 'open', when: cards.length > 0 },
        { key: 'r', does: 'restore', when: cards.length > 0 },
        { key: 'esc', does: 'close' }]}>
      <SelectList
        choices={archivedChoices(cards)}
        onSelect={(card) => { if (card) onOpen(card); }}
        onCancel={onCancel}
        onKey={(char, card) => { if (char === 'r' && card) onRestore(card); }}
        onNearEnd={onNearEnd}
        // Counts against the real total (/resume's shape) — the "↓ N more"
        // line says what is really below.
        total={total}
      />
    </Screen>
  );
}
