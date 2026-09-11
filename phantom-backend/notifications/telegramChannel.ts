// Telegram as a notification channel — sends a message to the authorized
// user's DM. The bot token and user id are resolved at send time so a
// channel created at boot picks up config changes without a restart.

import type { NotificationChannel } from './channel.js';
import type { Db } from '../db/client.js';
import { TelegramClient } from '../telegram/client.js';
import { resolveCredential, resolve } from '../settings.js';
import { logger } from '../log.js';

const log = logger('notifications');

export function telegramChannel(db: Db, encryptionKey: Buffer): NotificationChannel {
  return {
    name: 'telegram',
    async send(message: string) {
      try {
        const enabled = await resolve(db, 'telegram_enabled').catch(() => false);
        if (enabled !== true) return;
        const dm = Number(await resolve(db, 'telegram_authorized_user').catch(() => ''));
        if (!dm || !Number.isFinite(dm)) return;
        const token = (await resolveCredential(db, encryptionKey, 'telegram_bot_token')) ?? '';
        if (!token) return;
        await new TelegramClient(token).sendMessage(dm, message);
      } catch (e) {
        log.warn({ err: (e as Error).message }, 'telegram notification failed');
      }
    },
  };
}
