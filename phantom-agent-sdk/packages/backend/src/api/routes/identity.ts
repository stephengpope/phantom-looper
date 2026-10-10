// Identity's own routes, in the envelope (Better Auth's are at /api/auth/*,
// Identity.handler):
//
//   GET  /identity/me                 who am I — the service role key or a user's token
//   POST /identity/users  {email,name} (service role) bootstrap: a user, no mail
//   POST /identity/magic-link {email} (service role) bootstrap: the sign-in link, handed back
//   POST /identity/keys/:id/rotate     (a user) their user role key replaced: new key issued, old one gone
import type { FastifyInstance } from 'fastify';
import { ok } from '../HttpApi.js';
import type { PhantomBackend } from '../../PhantomBackend.js';

const TAG = { tags: ['identity'] };

export function identityRoutes(app: FastifyInstance, backend: PhantomBackend) {
  app.get('/identity/me', { schema: { ...TAG, summary: 'Who am I',
    description: 'The caller: the service role, or a user with their organization and role.' } },
  async (req) => ok(await backend.identity.require(req)));

  app.post<{ Body: { email: string; name?: string } }>('/identity/users', { config: { serviceRole: true }, schema: { ...TAG, summary: 'Create a user',
    description: 'Creates a user and their personal organization, without sending any email. For setting up the first user.',
    body: { type: 'object', required: ['email'], additionalProperties: false,
      properties: { email: { type: 'string', minLength: 3 }, name: { type: 'string', minLength: 1 } } } } },
  async (req) => ok(await backend.identity.createUser(req.body)));

  app.post<{ Body: { email: string } }>('/identity/magic-link', { config: { serviceRole: true }, schema: { ...TAG, summary: 'Get a sign-in link',
    description: 'Returns a sign-in link for a user instead of emailing it. For the first sign-in, before mail is set up.',
    body: { type: 'object', required: ['email'], additionalProperties: false, properties: { email: { type: 'string', minLength: 3 } } } } },
  async (req) => ok({ url: await backend.identity.magicLink(req.body.email) }));

  app.post<{ Params: { id: string } }>('/identity/keys/:id/rotate', { schema: { ...TAG, summary: 'Rotate a user role key',
    description: 'Replaces one of your user role keys in one step: a new key with the same name and expiry is issued and answered once, and the old one stops working. Yours only; sign-in or a user role key required.',
    params: { type: 'object', required: ['id'], properties: { id: { type: 'string', minLength: 1 } } } } },
  async (req) => {
    await backend.identity.require(req, { users: true });
    return ok(await backend.identity.rotateUserRoleKey(req, req.params.id));
  });
}
