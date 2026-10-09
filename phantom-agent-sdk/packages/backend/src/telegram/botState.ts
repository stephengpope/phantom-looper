// `telegram_bot_state` (migrations 012, 031, 054): the ONE row, id pinned 1
// — the link: the webhook registration (secret, encrypted at rest like
// every stored credential; URL) and the bot's name. State, not settings. What
// the bot does with a message — which agent answers, which session and
// project it points at — is the app's, in the app's own table
// (phantom-looper: TelegramAssistantState).

import { eq } from 'drizzle-orm';
import type { Drizzle } from '../storage/Database.js';
import { telegramBotState } from '../storage/schema.js';
import { encrypt, decrypt, decryptUnbound } from '../lib/crypto.js';

/** The name the secret's blob is bound to (lib/crypto.ts): the one row there is. */
const ROW = 'telegram_bot_state:webhook_secret';

export interface TelegramBotStateRow {
  webhookSecret: string | null;
  webhookUrl: string | null;
  botUsername: string | null;
}

const EMPTY: TelegramBotStateRow = { webhookSecret: null, webhookUrl: null, botUsername: null };

export class TelegramBotState {
  constructor(private readonly database: Drizzle, private readonly encryptionKey: Buffer) {}

  /** The one row, created on first read. */
  async read(): Promise<TelegramBotStateRow> {
    const rows = await this.database.select().from(telegramBotState).where(eq(telegramBotState.id, 1));
    if (!rows.length) {
      await this.database.insert(telegramBotState).values({ id: 1 }).onConflictDoNothing();
      return { ...EMPTY };
    }
    const row = rows[0];
    let webhookSecret: string | null = null;
    if (row.webhookSecretEnc) {
      try { webhookSecret = decrypt(this.encryptionKey, row.webhookSecretEnc, ROW); } catch { /* re-mint on next register */ }
    }
    return { webhookSecret, webhookUrl: row.webhookUrl, botUsername: row.botUsername };
  }

  private async patch(values: Partial<typeof telegramBotState.$inferInsert>): Promise<void> {
    await this.database.insert(telegramBotState).values({ id: 1, ...values })
      .onConflictDoUpdate({ target: telegramBotState.id, set: values });
  }

  /** The webhook is registered: its secret (encrypted at rest), URL and bot. */
  async saveRegistration(secret: string, url: string, botUsername: string | null): Promise<void> {
    await this.patch({ webhookSecretEnc: encrypt(this.encryptionKey, secret, ROW), webhookUrl: url, botUsername });
  }

  /** Boot, once per install: a secret written before blobs were bound to
   *  their row is written back bound (lib/crypto.ts). Remove once no
   *  install can be on a release before v0.1.93. */
  async bindRows(): Promise<void> {
    const [row] = await this.database.select().from(telegramBotState).where(eq(telegramBotState.id, 1));
    if (!row?.webhookSecretEnc) return;
    try { decrypt(this.encryptionKey, row.webhookSecretEnc, ROW); return; } catch { /* not bound yet, or unreadable */ }
    let plain: string;
    try { plain = decryptUnbound(this.encryptionKey, row.webhookSecretEnc); } catch { return; }
    await this.patch({ webhookSecretEnc: encrypt(this.encryptionKey, plain, ROW) });
  }

  async clearRegistration(): Promise<void> {
    await this.patch({ webhookSecretEnc: null, webhookUrl: null });
  }
}
