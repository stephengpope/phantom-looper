// The ONE public Telegram endpoint: the webhook. Telegram POSTs an update
// here; the bot verifies the secret-token header, checks the sender, dedups
// retries, fast-acks 200, and runs out-of-band (TelegramBot.receiveUpdate).
// It is the only route NOT behind the API bearer — Telegram cannot send it,
// and the secret token (timing-safe-checked in the bot) is the auth; the
// bearer hook lets this one path through (HttpApi.PUBLIC_PATHS). The bot
// registers the same path with Telegram (TelegramBot.webhookUrl).
import type { FastifyInstance } from 'fastify';
import type { PhantomBackend } from '../../PhantomBackend.js';
import { ok, err } from '../HttpApi.js';

import { TELEGRAM_WEBHOOK_PATH } from '../../telegram/webhookPath.js';
export { TELEGRAM_WEBHOOK_PATH };

export function telegramRoutes(app: FastifyInstance, ctx: PhantomBackend) {
  app.post(TELEGRAM_WEBHOOK_PATH, {
    // No schema validation on the body: Telegram's update shape is large and
    // versioned, and the bot reads only the fields it knows.
    schema: { tags: ['telegram'], summary: 'Receive Telegram updates',
      description: 'Where Telegram delivers the bot\'s messages. Only Telegram calls it. It is checked with Telegram\'s own secret, not an API key.' },
  }, async (req, reply) => {
    const secret = String(req.headers['x-telegram-bot-api-secret-token'] ?? '');
    const status = await ctx.telegramBot.receiveUpdate(secret, req.body ?? {});
    return reply.code(status).send('ok');
  });

  // Linking a chat — the caller's own (a user's, or the server key's for the
  // operator). The policies keep each user to their own links.
  const TAG = { tags: ['telegram'] };
  app.post<{ Body: { project?: string } }>('/telegram/links', { schema: { ...TAG, summary: 'Link a Telegram chat',
    description: 'Creates a one-time link that is valid for a short while. Opening it in Telegram links that chat to the caller: a private chat with `url`, or a group with `group_url`. With `project`, the chat is tied to that project.',
    body: { type: 'object', additionalProperties: false, properties: { project: { type: 'string' } } } } },
  async (req, reply) => {
    const projectId = req.body?.project ?? null;
    if (projectId && !await ctx.projects.get(projectId)) return reply.code(404).send(err('not_found', `no project ${projectId}`));
    const username = (await ctx.telegramBot.webhookStatus()).botUsername;
    if (!username) return reply.code(409).send(err('telegram_off', 'the Telegram bot is not connected on this server'));
    const { code, expiresAt } = await ctx.telegramChats.newCode(projectId);
    return ok({ url: `https://t.me/${username}?start=${code}`, group_url: `https://t.me/${username}?startgroup=${code}`,
      expires_at: expiresAt.toISOString() });
  });
  app.get('/telegram/links', { schema: { ...TAG, summary: 'List linked Telegram chats',
      description: 'The caller\'s linked Telegram chats.' } },
    async () => ok({ chats: await ctx.telegramChats.list() }));
  app.delete<{ Params: { id: string } }>('/telegram/links/:id', { schema: { ...TAG, summary: 'Unlink a Telegram chat',
      description: 'Removes one of the caller\'s linked chats. The bot stops answering it.' } },
    async (req, reply) => (await ctx.telegramChats.remove(req.params.id)) ? ok({ unlinked: req.params.id })
      : reply.code(404).send(err('not_found', `no linked chat ${req.params.id}`)));
}
