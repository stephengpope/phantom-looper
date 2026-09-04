// The ONE public Telegram endpoint: the webhook. Telegram POSTs an update
// here; the engine verifies the secret-token header, checks the sender, dedups
// retries, fast-acks 200, and runs out-of-band. It is the only route that is
// NOT behind the API bearer — Telegram cannot send it, and the secret token
// (timing-safe-checked in the engine) is the auth. So it is registered with
// its own preValidation that skips the bearer hook's audience by matching the
// path before the hook runs is not possible; instead the hook allows this one
// path through (see api/app.ts).

import type { FastifyInstance } from 'fastify';
import type { AppCtx } from '../app.js';

export function telegramRoutes(app: FastifyInstance, ctx: AppCtx) {
  app.post('/telegram/webhook', {
    // No schema validation on the body: Telegram's update shape is large and
    // versioned, and the engine reads only the fields it knows.
    schema: { tags: ['telegram'], summary: 'Telegram webhook',
      description: 'Receives a Telegram update. Auth is the secret-token header, not the API bearer.' },
  }, async (req, reply) => {
    if (!ctx.telegram) return reply.code(200).send('ok');
    const secret = String(req.headers['x-telegram-bot-api-secret-token'] ?? '');
    const status = await ctx.telegram.handleUpdate(secret, req.body ?? {});
    return reply.code(status).send('ok');
  });
}
