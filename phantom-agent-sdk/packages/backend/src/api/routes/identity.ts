// Identity's own routes, in the envelope (Better Auth's are at /api/auth/*,
// Identity.handler):
//
//   GET  /identity/me                 who am I — the operator's key or a user's token
//   POST /identity/users  {email,name} (operator) bootstrap: a user, no mail
//   POST /identity/magic-link {email} (operator) bootstrap: the sign-in link, handed back
import type { FastifyInstance } from 'fastify';
import { ok } from '../HttpApi.js';
import type { PhantomBackend } from '../../PhantomBackend.js';

const TAG = { tags: ['identity'] };

export function identityRoutes(app: FastifyInstance, backend: PhantomBackend) {
  app.get('/identity/me', { config: { caller: true }, schema: { ...TAG, summary: 'Who am I',
    description: 'The caller: `{kind: "operator"}` for the API key; `{kind: "user", user, organization, role}` for a Better Auth session, bearer token or API key. 401 for nobody.' } },
  async (req) => ok(await backend.identity.require(req)));

  app.post<{ Body: { email: string; name?: string } }>('/identity/users', { schema: { ...TAG, summary: 'Create a user (bootstrap)',
    description: 'The operator makes the first user with no mail involved: a user row and their personal organization. 409 `email_taken`. 503 `disabled` when identity is off.',
    body: { type: 'object', required: ['email'], additionalProperties: false,
      properties: { email: { type: 'string', minLength: 3 }, name: { type: 'string', minLength: 1 } } } } },
  async (req) => ok(await backend.identity.createUser(req.body)));

  app.post<{ Body: { email: string } }>('/identity/magic-link', { schema: { ...TAG, summary: 'A sign-in link (bootstrap)',
    description: 'The magic link for `email`, handed back instead of mailed — for the first sign-in before SMTP is set, or a link to paste. Opening it signs the user in; `GET` without a callbackURL answers the session and a bearer token (`set-auth-token`).',
    body: { type: 'object', required: ['email'], additionalProperties: false, properties: { email: { type: 'string', minLength: 3 } } } } },
  async (req) => ok({ url: await backend.identity.magicLink(req.body.email) }));
}
