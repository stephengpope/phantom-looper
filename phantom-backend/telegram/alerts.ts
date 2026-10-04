// Auto build alerts — the pure decision: which card events become a DM.
// The supervisor's moves ONLY: a card it moved to in_progress or done,
// a card the coder or a failed round blocked. A person's move (the cli, the
// pane Assistant, Telegram's own Assistant) is never announced — the writer's
// x-phantom-looper-client rides the event, and the loop's is LOOP_CLIENT_ID.
// `from` is the status before the write, so an edit inside a column (a tick, a
// retitle) is not a move, and nothing is remembered across a restart.
import type { BoardEvent } from 'phantom-backend-sdk';
import { LOOP_CLIENT_ID } from '../looper/Looper.js';

/** The statuses worth a message, and their glyphs. plan is the looper's
 *  waiting room, not news; archived is the human's own gesture. */
export const ALERT_STATUSES: Record<string, string> = {
  in_progress: '🔨',
  blocked: '🚫',
  done: '✅',
};

export interface Alert { number: number; status: string; text: string }

/** The alert for a board event, or null when it is not one: not a card write,
 *  not the supervisor's, not a status change, or not into an alert status. */
export function autoBuildAlert(event: BoardEvent, prefix: string): Alert | null {
  if (event.event !== 'card' || event.client !== LOOP_CLIENT_ID) return null;
  const status = String(event.card.status ?? '');
  if (!event.from || event.from === status) return null;
  const glyph = ALERT_STATUSES[status];
  if (!glyph) return null;
  const number = Number(event.card.number);
  const title = String(event.card.title ?? '').trim();
  const reason = status === 'blocked' ? String(event.card.blocked_reason ?? '').trim() : '';
  const tail = reason || title;
  return { number, status,
    text: `${glyph} ${prefix}-${number} → ${status.replace('_', ' ')}${tail ? `  ${tail}` : ''}` };
}
