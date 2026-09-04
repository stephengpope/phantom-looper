import { randomBytes } from 'node:crypto';

// knack's status set (kanbanStatus in ../knack/lib/db/schema.ts) reshaped:
// leftmost renamed 'backlog' (not knack's 'todo'), 'plan' added after it,
// 'review' removed (workspace schema v10 moved its cards). The one default
// column list, shared by the server route and the kanban tool schemas so the
// model can only send a real column name.
export const DEFAULT_COLUMNS = ['backlog', 'plan', 'in_progress', 'blocked', 'done'];

// Checklist items ({key, text, done}) are addressed by key: ticking names the
// item, never resends the list — a mis-sent list was wiping whole checklists.
// The key is a short random id, assigned by the SERVER when the item first
// appears and FROZEN for the item's life. Random, never derived from the
// text: a text-derived key invites the model to guess it, and a guess can
// silently hit the WRONG item (duplicate texts, an item reworded since its
// key was made). An id can only be COPIED from a read or a write result —
// always right — or missed loudly (the error names the real keys).
// workspaceSchema v8 backfilled the items that existed before keys with
// slugs of their text; those keys are ordinary ids now, kept as they are.

export interface ChecklistItem { key?: string; text: string; done?: boolean }

/** Keys are lowercase. Models echo them cased ("K7F2", "Three" for a v8 key
 *  "three") — so any key coming in, on a write or a tick, passes through
 *  this first and case can never miss. */
export const normalizeKey = (k: string): string =>
  k.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const newKey = (): string =>
  Array.from(randomBytes(4), (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');

/** Normalize a list on WRITE: keep every key the caller sent (it came from a
 *  read — identity must survive a reword or reorder), assign fresh ids to new
 *  items, and re-id a duplicate so a key names exactly one item. */
export function keyedItems(items: ChecklistItem[]): { key: string; text: string; done: boolean }[] {
  const used = new Set<string>();
  return items.map((it) => {
    let key = (it.key && normalizeKey(it.key)) || newKey();
    while (used.has(key)) key = newKey();
    used.add(key);
    return { key, text: it.text, done: it.done ?? false };
  });
}
