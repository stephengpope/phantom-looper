// Auto build alerts — the pure decision: which card events become a DM.
// The loop's moves ONLY: a card the supervisor moved to in_progress or done,
// a card the coder or a failed round blocked. A person's move (the cli, the
// pane Assistant, Telegram's own Assistant) is never announced — the writer's
// x-phantom-looper-client rides the event, and the loop's is LOOP_CLIENT_ID.
// `from` is the status before the write, so an edit inside a column (a tick, a
// retitle) is not a move, and nothing is remembered across a restart.
import type { BoardEvent } from '../api/boardEvents.js';
import { LOOP_CLIENT_ID } from '../sessions.js';

/** The statuses worth a message, and their glyphs. plan is the loop's
 *  waiting room, not news; archived is the human's own gesture. */
export const ALERT_STATUSES: Record<string, string> = {
  in_progress: '🔨',
  blocked: '🚫',
  done: '✅',
};

export interface Alert { seq: number; status: string; text: string }

/** The alert for a board event, or null when it is not one: not a card write,
 *  not the loop's, not a status change, or not into an alert status. */
export function autoBuildAlert(e: BoardEvent, prefix: string): Alert | null {
  if (e.event !== 'card' || e.client !== LOOP_CLIENT_ID) return null;
  const status = String(e.card.status ?? '');
  if (!e.from || e.from === status) return null;
  const glyph = ALERT_STATUSES[status];
  if (!glyph) return null;
  const seq = Number(e.card.seq);
  const title = String(e.card.title ?? '').trim();
  const reason = status === 'blocked' ? String(e.card.blocked_reason ?? '').trim() : '';
  const tail = reason || title;
  return { seq, status,
    text: `${glyph} ${prefix}-${seq} → ${status.replace('_', ' ')}${tail ? `  ${tail}` : ''}` };
}
