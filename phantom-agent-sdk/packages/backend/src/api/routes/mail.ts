// Mail — one route: prove SMTP before anyone is invited.
//
//   POST /mail/test  { to }  → { sent: true }
import type { FastifyInstance } from 'fastify';
import { ok, err } from '../HttpApi.js';
import { MailerError } from '../../mail/Mailer.js';
import type { PhantomBackend } from '../../PhantomBackend.js';

const TAG = { tags: ['mail'] };

export function mailRoutes(app: FastifyInstance, backend: PhantomBackend) {
  app.post<{ Body: { to: string } }>('/mail/test', { config: { operator: true }, schema: { ...TAG, summary: 'Send a test email',
    description: 'Sends one email to the given address through the server\'s mail settings, to check they work.',
    body: { type: 'object', required: ['to'], additionalProperties: false, properties: { to: { type: 'string', minLength: 3 } } } } },
  async (req, reply) => {
    try {
      await backend.mailer.send({ to: req.body.to, subject: 'mail works',
        text: `This is the test mail from your backend at ${process.env.BACKEND_ADDRESS ?? 'this server'}. Mail is configured.` });
      return ok({ sent: true });
    } catch (error) {
      if (error instanceof MailerError) {
        return reply.code(error.code === 'not_configured' ? 409 : 502).send(err(`mail_${error.code}`, error.message));
      }
      throw error;
    }
  });
}
