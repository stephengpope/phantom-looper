// `telegram_handled_updates` (migrations 012, 031): one row per Telegram
// update_id already handled. Telegram re-delivers an update it did not get
// acknowledged fast enough; the repeat loses the insert on the primary key
// and is dropped. Rows exist only to answer that, so old ones are pruned in
// passing — update ids climb per bot, so anything far behind is done.

import { lt } from 'drizzle-orm';
import type { Drizzle } from '../storage/Database.js';
import { telegramHandledUpdates } from '../storage/schema.js';

const PRUNE_BEHIND = 10_000;

export class TelegramHandledUpdates {
  constructor(private readonly database: Drizzle) {}

  /** True the FIRST time an update id is seen; false for a repeat. */
  async markHandled(updateId: number): Promise<boolean> {
    if (!Number.isFinite(updateId)) return true;
    const inserted = await this.database.insert(telegramHandledUpdates).values({ updateId }).onConflictDoNothing().returning();
    this.database.delete(telegramHandledUpdates).where(lt(telegramHandledUpdates.updateId, updateId - PRUNE_BEHIND))
      .catch(() => { /* housekeeping */ });
    return inserted.length > 0;
  }
}
