// Secrets — user-named tokens the coding agent reads (the cli adds and
// deletes). The settings table's `secret` namespace: free names, one row per
// secret, token encrypted, description plain. Two layers — global and
// workspace — workspace winning a name collision, the same chain the GitHub
// token walks. Writes and deletes address ONE explicit layer; only the value
// GET cascades.
//
//   GET    /secrets            names + descriptions (+?workspace= merges that layer)
//   PUT    /secrets/:name      create or overwrite {description?, value} at one layer
//   GET    /secrets/:name      the decrypted value, workspace → global
//   DELETE /secrets/:name      remove at one layer
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { workspaces } from '../../db/schema.js';
import {
  listSecrets, listAllSecrets, readSecretValue, putSecret, dropSecret,
  GLOBAL, workspaceScope,
} from '../../store.js';
import { ok, err, type AppCtx } from '../app.js';

const TAG = { tags: ['secrets'] };
const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const scopeQuery = { type: 'object', properties: {
  workspace: { type: 'string', description: 'Address this workspace\'s layer (list merges it; write/delete target it; the value GET has it win over global).' },
} };
const nameParam = { type: 'object', required: ['name'],
  properties: { name: { type: 'string' } } };

export function secretsRoutes(app: FastifyInstance, ctx: AppCtx) {
  /** The scopes a request reads, most specific LAST — and the one it writes.
   *  A workspace id is verified to exist, or a typo becomes a row nothing
   *  will ever read. */
  async function scopesOf(q: { workspace?: string }):
  Promise<{ error: string } | { chain: string[]; write: string; label: 'global' | 'workspace' }> {
    if (!q.workspace) return { chain: [GLOBAL], write: GLOBAL, label: 'global' };
    const rows = await ctx.db.select().from(workspaces).where(eq(workspaces.id, q.workspace));
    if (!rows.length) return { error: `no workspace ${q.workspace}` };
    return { chain: [GLOBAL, workspaceScope(q.workspace)], write: workspaceScope(q.workspace), label: 'workspace' };
  }

  app.get<{ Querystring: { workspace?: string } }>(
    '/secrets', { schema: { ...TAG,
      summary: 'Every secret — names and descriptions, never values',
      description: 'With ?workspace=: global + that workspace\'s layer, merged — the agent\'s view. Bare: EVERY layer on the server (the cli\'s list, which saves to any workspace), each workspace row carrying its `workspace` id. Either way `scope` says the layer, and the same name at two layers lists twice — the more specific one wins when a value is read.',
      querystring: scopeQuery } },
    async (req, reply) => {
      const sc = await scopesOf(req.query);
      if ('error' in sc) return reply.code(404).send(err('not_found', sc.error));
      const raw = req.query.workspace
        ? await listSecrets(ctx.db, sc.chain)
        : await listAllSecrets(ctx.db);
      const secrets = raw.map((s) => ({
        name: s.name, description: s.description,
        scope: s.scope === GLOBAL ? 'global' : 'workspace',
        ...(s.scope === GLOBAL ? {} : { workspace: s.scope.replace(/^workspace:/, '') }),
      }));
      return ok({ secrets });
    });

  app.put<{ Params: { name: string }; Querystring: { workspace?: string };
    Body: { description?: string; value?: string } }>(
    '/secrets/:name', { schema: { ...TAG,
      summary: 'Create or overwrite one secret at one layer',
      description: 'Body is {description?, value}. Writing an existing name at the same layer overwrites it — that is the update path; there is no separate one. Names: lowercase letters, digits, underscores, starting with a letter.',
      params: nameParam, querystring: scopeQuery,
      body: { type: 'object', properties: {
        description: { type: 'string' }, value: { type: 'string' } } } } },
    async (req, reply) => {
      const name = req.params.name;
      if (!NAME.test(name)) {
        return reply.code(400).send(err('invalid_args',
          `secret names are lowercase letters, digits and underscores, starting with a letter (got "${name}")`));
      }
      const value = req.body?.value;
      if (typeof value !== 'string' || value.length === 0) {
        return reply.code(400).send(err('invalid_args', 'body.value (the secret itself) is required'));
      }
      const sc = await scopesOf(req.query);
      if ('error' in sc) return reply.code(404).send(err('not_found', sc.error));
      await putSecret(ctx.db, ctx.encryptionKey, sc.write, name,
        String(req.body?.description ?? ''), value);
      return ok({ name, scope: sc.label });
    });

  app.get<{ Params: { name: string }; Querystring: { workspace?: string } }>(
    '/secrets/:name', { schema: { ...TAG,
      summary: 'One secret\'s value',
      description: 'Decrypted. Resolution cascades: the workspace layer (when ?workspace= is passed) wins over global. An unknown name answers with the names that do exist.',
      params: nameParam, querystring: scopeQuery } },
    async (req, reply) => {
      const sc = await scopesOf(req.query);
      if ('error' in sc) return reply.code(404).send(err('not_found', sc.error));
      const value = await readSecretValue(ctx.db, ctx.encryptionKey, req.params.name, sc.chain);
      if (value === undefined) {
        const names = (await listSecrets(ctx.db, sc.chain)).map((s) => s.name);
        return reply.code(404).send(err('not_found',
          `no secret named "${req.params.name}" — stored: ${names.length ? names.join(', ') : '(none)'}`));
      }
      return ok({ name: req.params.name, value });
    });

  app.delete<{ Params: { name: string }; Querystring: { workspace?: string } }>(
    '/secrets/:name', { schema: { ...TAG,
      summary: 'Delete one secret at one layer',
      description: 'Removes the row at the addressed layer only — a global secret shadowed by a workspace one survives the workspace delete, and the other way round.',
      params: nameParam, querystring: scopeQuery } },
    async (req, reply) => {
      const sc = await scopesOf(req.query);
      if ('error' in sc) return reply.code(404).send(err('not_found', sc.error));
      const gone = await dropSecret(ctx.db, sc.write, req.params.name);
      if (!gone) {
        return reply.code(404).send(err('not_found',
          `no secret named "${req.params.name}" at the ${sc.label} layer`));
      }
      return ok({ deleted: req.params.name, scope: sc.label });
    });
}
