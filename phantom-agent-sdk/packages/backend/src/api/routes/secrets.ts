// Secrets — user-named tokens the coding agent reads (the cli adds and
// deletes). The settings table's `secret` namespace: free names, one row per
// secret, token encrypted, description plain. Two layers — global and
// project — project winning a name collision, the same chain the GitHub
// token walks. Writes and deletes address ONE explicit layer; only the value
// GET cascades.
//
//   GET    /secrets            names + descriptions (+?project= merges that layer)
//   PUT    /secrets/:name      create or overwrite {description?, value?} at one layer
//                             (no value = keep the stored one, description only)
//   GET    /secrets/:name      the decrypted value, project → global
//   DELETE /secrets/:name      remove at one layer
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GLOBAL, type Layer, type SettingScope, layerOf, scopeNames, scopeOf } from '../../lib/scopes.js';
import { ok, err } from '../HttpApi.js';
import { ownLayers } from '../ownLayers.js';
import type { PhantomBackend } from '../../PhantomBackend.js';
import { secretName, SECRET_NAME_RULE } from '@phantom-agent-sdk/client';

const TAG = { tags: ['secrets'] };
const scopeQuery = { type: 'object', properties: {
  organization: { type: 'string', description: 'The organization\'s layer (list merges it; write/delete target the deepest named; the value GET walks the chain).' },
  user: { type: 'string', description: 'The user\'s layer.' },
  project: { type: 'string', description: 'The project\'s layer (its organization\'s rides along).' },
} };
type ScopeQuery = { organization?: string; user?: string; project?: string };
const nameParam = { type: 'object', required: ['name'],
  properties: { name: { type: 'string' } } };

export function secretsRoutes(app: FastifyInstance, ctx: PhantomBackend) {
  /** The scopes a request reads, in chain order (most specific LAST) — and
   *  the one it writes: the deepest named. Each id is verified to exist, or
   *  a typo becomes a row nothing will ever read. */
  async function scopesOf(req: FastifyRequest<{ Querystring: ScopeQuery }>):
  Promise<{ error: string } | { chain: string[]; write: string; label: Layer }> {
    const query = req.query;
    const own = ownLayers(req.caller, query);
    if (own === 'denied') return { error: 'access denied' };
    let scope: SettingScope = { ...own };
    if (query.organization) {
      if (!await ctx.identity.organization(query.organization)) return { error: `no organization ${query.organization}` };
      scope.organizationId = query.organization;
    }
    if (query.user) {
      if (!await ctx.identity.user(query.user)) return { error: `no user ${query.user}` };
      scope.userId = query.user;
    }
    if (query.project) {
      const project = await ctx.projects.get(query.project);
      if (!project) return { error: `no project ${query.project}` };
      scope = { ...scope, ...scopeOf(project) };
    }
    const label: Layer = query.project ? 'project' : query.user ? 'user' : query.organization ? 'organization' : 'global';
    const names = scopeNames(scope);
    return { chain: Object.values(names), write: names[label] ?? GLOBAL, label };
  }

  app.get<{ Querystring: ScopeQuery }>(
    '/secrets', { schema: { ...TAG,
      summary: 'Every secret — names and descriptions, never values',
      description: 'With a layer named (?project=, ?organization=, ?user=): that chain, merged — the agent\'s view. Bare: EVERY layer on the server (the cli\'s list, which saves to any project), each row carrying the id of its layer (`project`, `organization` or `user`). Either way `scope` says the layer, and the same name at two layers lists twice — the more specific one wins when a value is read.',
      querystring: scopeQuery } },
    async (req, reply) => {
      const scopes = await scopesOf(req);
      if ('error' in scopes) return reply.code(404).send(err('not_found', scopes.error));
      // Bare, the server key lists every layer on the server; a user, their own chain.
      const raw = scopes.label !== 'global' || req.caller?.type === 'user'
        ? await ctx.settings.listSecrets(scopes.chain)
        : await ctx.settings.listAllSecrets();
      const secrets = raw.map((secret) => {
        const layer = layerOf(secret.scope);
        return { name: secret.name, description: secret.description, scope: layer,
          ...(layer === 'global' ? {} : { [layer]: secret.scope.slice(layer.length + 1) }) };
      });
      return ok({ secrets });
    });

  app.put<{ Params: { name: string }; Querystring: ScopeQuery;
    Body: { description?: string; value?: string } }>(
    '/secrets/:name', { schema: { ...TAG,
      summary: 'Create or overwrite one secret at one layer',
      description: 'Body is {description?, value?}. Writing an existing name at the same layer overwrites it — that is the update path; there is no separate one. Omit `value` to change only the description of a secret already stored at that layer (400 when nothing is there to keep). Names are stored UPPER_CASE (letters, digits, underscores, starting with a letter); whatever case is sent is uppercased.',
      params: nameParam, querystring: scopeQuery,
      body: { type: 'object', properties: {
        description: { type: 'string' }, value: { type: 'string' } } } } },
    async (req, reply) => {
      const name = secretName(req.params.name);
      if (!name) {
        return reply.code(400).send(err('invalid_args',
          `secret names are ${SECRET_NAME_RULE} (got "${req.params.name}")`));
      }
      // An empty string is a mistake ("" is not a token); an ABSENT value is
      // a description-only edit of a secret already there.
      const value = req.body?.value;
      if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
        return reply.code(400).send(err('invalid_args', 'body.value (the secret itself) must not be empty'));
      }
      const scopes = await scopesOf(req);
      if ('error' in scopes) return reply.code(404).send(err('not_found', scopes.error));
      const stored = await ctx.settings.writeSecret(scopes.write, name,
        String(req.body?.description ?? ''), value);
      if (!stored) {
        return reply.code(400).send(err('invalid_args',
          `body.value (the secret itself) is required — nothing named "${name}" is stored at the ${scopes.label} layer to keep`));
      }
      return ok({ name, scope: scopes.label });
    });

  app.get<{ Params: { name: string }; Querystring: ScopeQuery }>(
    '/secrets/:name', { schema: { ...TAG,
      summary: 'One secret\'s value',
      description: 'Decrypted. Resolution walks the chain: global, then the organization, the user, the project — the deepest layer named wins. Name is case-insensitive. An unknown name answers with the names that do exist.',
      params: nameParam, querystring: scopeQuery } },
    async (req, reply) => {
      const scopes = await scopesOf(req);
      if ('error' in scopes) return reply.code(404).send(err('not_found', scopes.error));
      const name = secretName(req.params.name);
      const value = name ? await ctx.settings.readSecret(name, scopes.chain) : undefined;
      if (value === undefined) {
        const names = (await ctx.settings.listSecrets(scopes.chain)).map((secret) => secret.name);
        return reply.code(404).send(err('not_found',
          `no secret named "${req.params.name}" — stored: ${names.length ? names.join(', ') : '(none)'}`));
      }
      return ok({ name, value });
    });

  app.delete<{ Params: { name: string }; Querystring: ScopeQuery }>(
    '/secrets/:name', { schema: { ...TAG,
      summary: 'Delete one secret at one layer',
      description: 'Removes the row at the addressed layer only — a global secret shadowed by a project one survives the project delete, and the other way round.',
      params: nameParam, querystring: scopeQuery } },
    async (req, reply) => {
      const scopes = await scopesOf(req);
      if ('error' in scopes) return reply.code(404).send(err('not_found', scopes.error));
      const name = secretName(req.params.name);
      const gone = name ? await ctx.settings.deleteSecret(scopes.write, name) : false;
      if (!gone) {
        return reply.code(404).send(err('not_found',
          `no secret named "${req.params.name}" at the ${scopes.label} layer`));
      }
      return ok({ deleted: req.params.name, scope: scopes.label });
    });
}
