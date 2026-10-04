// The ONE public Telegram endpoint: the webhook. Telegram POSTs an update
// here; the bot verifies the secret-token header, checks the sender, dedups
// retries, fast-acks 200, and runs out-of-band (TelegramBot.receiveUpdate).
// It is the only route NOT behind the API bearer — Telegram cannot send it,
// and the secret token (timing-safe-checked in the bot) is the auth; the
// bearer hook lets this one path through (HttpApi.PUBLIC_PATHS). The bot
// registers the same path with Telegram (TelegramBot.webhookUrl).
import type { FastifyInstance } from 'fastify';
import type { PhantomBackend } from '../../PhantomBackend.js';

export const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';

export function telegramRoutes(app: FastifyInstance, ctx: PhantomBackend) {
  app.post(TELEGRAM_WEBHOOK_PATH, {
    // No schema validation on the body: Telegram's update shape is large and
    // versioned, and the bot reads only the fields it knows.
    schema: { tags: ['telegram'], summary: 'Telegram webhook',
      description: 'Receives a Telegram update. Auth is the secret-token header, not the API bearer.' },
  }, async (req, reply) => {
    const secret = String(req.headers['x-telegram-bot-api-secret-token'] ?? '');
    const status = await ctx.telegramBot.receiveUpdate(secret, req.body ?? {});
    return reply.code(status).send('ok');
  });
}
