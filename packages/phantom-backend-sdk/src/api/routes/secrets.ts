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
import type { FastifyInstance } from 'fastify';
import { GLOBAL, projectScope } from '../../lib/scopes.js';
import { ok, err } from '../HttpApi.js';
import type { PhantomBackend } from '../../PhantomBackend.js';
import { secretName, SECRET_NAME_RULE } from 'phantom-client-sdk';

const TAG = { tags: ['secrets'] };
const scopeQuery = { type: 'object', properties: {
  project: { type: 'string', description: 'Address this project\'s layer (list merges it; write/delete target it; the value GET has it win over global).' },
} };
const nameParam = { type: 'object', required: ['name'],
  properties: { name: { type: 'string' } } };

export function secretsRoutes(app: FastifyInstance, ctx: PhantomBackend) {
  /** The scopes a request reads, most specific LAST — and the one it writes.
   *  A project id is verified to exist, or a typo becomes a row nothing
   *  will ever read. */
  async function scopesOf(query: { project?: string }):
  Promise<{ error: string } | { chain: string[]; write: string; label: 'global' | 'project' }> {
    if (!query.project) return { chain: [GLOBAL], write: GLOBAL, label: 'global' };
    if (!await ctx.projects.get(query.project)) return { error: `no project ${query.project}` };
    return { chain: [GLOBAL, projectScope(query.project)], write: projectScope(query.project), label: 'project' };
  }

  app.get<{ Querystring: { project?: string } }>(
    '/secrets', { schema: { ...TAG,
      summary: 'Every secret — names and descriptions, never values',
      description: 'With ?project=: global + that project\'s layer, merged — the agent\'s view. Bare: EVERY layer on the server (the cli\'s list, which saves to any project), each project row carrying its `project` id. Either way `scope` says the layer, and the same name at two layers lists twice — the more specific one wins when a value is read.',
      querystring: scopeQuery } },
    async (req, reply) => {
      const scopes = await scopesOf(req.query);
      if ('error' in scopes) return reply.code(404).send(err('not_found', scopes.error));
      const raw = req.query.project
        ? await ctx.settings.listSecrets(scopes.chain)
        : await ctx.settings.listAllSecrets();
      const secrets = raw.map((secret) => ({
        name: secret.name, description: secret.description,
        scope: secret.scope === GLOBAL ? 'global' : 'project',
        ...(secret.scope === GLOBAL ? {} : { project: secret.scope.replace(/^project:/, '') }),
      }));
      return ok({ secrets });
    });

  app.put<{ Params: { name: string }; Querystring: { project?: string };
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
      const scopes = await scopesOf(req.query);
      if ('error' in scopes) return reply.code(404).send(err('not_found', scopes.error));
      const stored = await ctx.settings.writeSecret(scopes.write, name,
        String(req.body?.description ?? ''), value);
      if (!stored) {
        return reply.code(400).send(err('invalid_args',
          `body.value (the secret itself) is required — nothing named "${name}" is stored at the ${scopes.label} layer to keep`));
      }
      return ok({ name, scope: scopes.label });
    });

  app.get<{ Params: { name: string }; Querystring: { project?: string } }>(
    '/secrets/:name', { schema: { ...TAG,
      summary: 'One secret\'s value',
      description: 'Decrypted. Resolution cascades: the project layer (when ?project= is passed) wins over global. Name is case-insensitive. An unknown name answers with the names that do exist.',
      params: nameParam, querystring: scopeQuery } },
    async (req, reply) => {
      const scopes = await scopesOf(req.query);
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

  app.delete<{ Params: { name: string }; Querystring: { project?: string } }>(
    '/secrets/:name', { schema: { ...TAG,
      summary: 'Delete one secret at one layer',
      description: 'Removes the row at the addressed layer only — a global secret shadowed by a project one survives the project delete, and the other way round.',
      params: nameParam, querystring: scopeQuery } },
    async (req, reply) => {
      const scopes = await scopesOf(req.query);
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
