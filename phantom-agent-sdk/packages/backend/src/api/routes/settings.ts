// The settings store.
//
//   GET    /settings           every setting, resolved with its layers
//   PATCH  /settings           write; null clears a key
//   DELETE /settings/:key      clear one
//   GET    /settings/events    change notices (no values — listeners re-read)
//
// Every key is declared in code (settings.ts) — defaults, types, descriptions,
// whether a project may override it. Unknown keys are refused: a store
// where every key is declared is what keeps a typo from becoming an override
// nothing reads. `?project=<id>` reads or writes that project's layer —
// THE door for project overrides (the cli's project screen, the token).
//
// Credentials are returned decrypted; which keys are credentials is declared
// in code (CREDENTIALS), never decided by a write.
import type { FastifyInstance } from 'fastify';
import type { FastifyRequest } from 'fastify';
import { SettingsWriteError } from '../../storage/Settings.js';
import { GLOBAL, LAYERS, type Layer, type SettingScope, organizationScope, scopeNames, scopeOf, userScope } from '../../lib/scopes.js';
import { acting, actAs } from '../../lib/acting.js';
import { ok, err } from '../HttpApi.js';
import { ownLayers } from '../ownLayers.js';
import type { PhantomBackend } from '../../PhantomBackend.js';

const writerOf = (req: FastifyRequest): string | undefined =>
  String(req.headers['x-phantom-client'] ?? '') || undefined;

const TAG = { tags: ['settings'] };
const scopeQuery = { type: 'object', properties: {
  organization: { type: 'string', description: 'The organization\'s layer: read it; write it when it is the deepest named.' },
  user: { type: 'string', description: 'The user\'s layer.' },
  project: { type: 'string', description: 'The project\'s layer (its organization\'s rides along).' },
} };
type ScopeQuery = { organization?: string; user?: string; project?: string };

export function settingsRoutes(app: FastifyInstance, ctx: PhantomBackend) {
  /** The scope one request addresses: every layer named is read; the
   *  deepest named is written. Verifying each id exists is what stops a
   *  typo becoming an override nothing will ever read — the row would be
   *  perfectly valid and perfectly dead. A project brings its organization. */
  type Scope = { error: string } | { scope: SettingScope; write: string; kind: Layer };
  async function scopeFor(req: FastifyRequest<{ Querystring: ScopeQuery }>): Promise<Scope> {
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
    const kind: Layer = query.project ? 'project' : query.user ? 'user' : query.organization ? 'organization' : 'global';
    return { scope, write: scopeNames(scope)[kind] ?? GLOBAL, kind };
  }

  app.get<{ Querystring: ScopeQuery }>(
    '/settings', { schema: { ...TAG,
      summary: 'Every setting, resolved',
      description: 'Every setting with its LAYERS — `default` (code), `global`, `organization`, `user`, `project` — plus the computed `value` and `source` (the layer it came from), and `description`/`meta`/`overridable`/`overridableAt` so a client renders an editor from this one call. Pass ?organization=, ?user=, ?project= to fill in those layers (a project brings its organization). Credentials come back decrypted, flagged `secret`.',
      querystring: scopeQuery } },
    async (req, reply) => {
      const where = await scopeFor(req);
      if ('error' in where) return reply.code(404).send(err('not_found', where.error));
      const entries = await ctx.settings.layersForScope(where.scope);
      const credentials = await ctx.settings.credentialLayers(where.scope);
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(entries)) {
        // A project-only key has no global meaning — the global list omits it.
        if (where.kind === 'global' && !ctx.settings.isGlobalSettable(key)) continue;
        // A user sees what they could act on: keys settable below global.
        // The server's own (limits, mail, the console) are the operator's.
        if (req.caller?.type === 'user' && !ctx.settings.overridableAt(key).length) continue;
        if (!entry.secret) { out[key] = { ...entry, secret: false }; continue; }
        // Credentials are keys of the same store — same table, same chain —
        // and this route answers them decrypted: every layer, the deepest set winning.
        const layers = credentials[key];
        let value: string | null = null; let source: string = 'default';
        for (const layer of LAYERS) if (layers[layer] != null) { value = layers[layer]; source = layer; }
        out[key] = { ...entry, ...layers, value, source };
      }
      return ok(out);
    });

  app.patch<{ Querystring: ScopeQuery; Body: Record<string, unknown> }>(
    '/settings', { schema: { ...TAG,
      summary: 'Write settings',
      description: 'Body is {key: value}. null CLEARS a key — the same rule at every layer, and null is never a stored value. An empty string is a real empty string. ' +
        'Which keys are credentials is declared in code, so they are stored encrypted without any flag. Unknown keys are refused. ' +
        'Pass ?organization=, ?user= or ?project= to write that layer (the deepest named); a key that layer may not override is refused.',
      querystring: scopeQuery,
      body: { type: 'object', additionalProperties: true } } },
    async (req, reply) => {
      const scope = await scopeFor(req);
      if ('error' in scope) return reply.code(404).send(err('not_found', scope.error));
      let updated: string[];
      try {
        updated = await ctx.settings.writeAtScope(scope.kind, scope.write, req.body ?? {}, writerOf(req));
      } catch (error) {
        if (error instanceof SettingsWriteError) return error.code === 'fixed' ? reply.code(403).send(err('access_denied', 'access denied')) : reply.code(400).send(err(error.code, error.message));
        throw error;
      }
      // Every write lands on the settings feed (Settings.write): the looper
      // and the Telegram engine listen there, whichever door wrote.
      return ok({ updated });
    });

  app.delete<{ Params: { key: string }; Querystring: ScopeQuery }>(
    '/settings/:key', { schema: { ...TAG,
      summary: 'Clear one key',
      description: 'Identical to PATCH with null. The setting reverts to the code default and follows it if the default changes later — a different state from being set to the same value.',
      params: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      querystring: scopeQuery } },
    async (req, reply) => {
      const scope = await scopeFor(req);
      if ('error' in scope) return reply.code(404).send(err('not_found', scope.error));
      try {
        await ctx.settings.writeAtScope(scope.kind, scope.write, { [req.params.key]: null }, writerOf(req));
      } catch (error) {
        if (error instanceof SettingsWriteError) return error.code === 'fixed' ? reply.code(403).send(err('access_denied', 'access denied')) : reply.code(400).send(err(error.code, error.message));
        throw error;
      }
      return ok({ cleared: req.params.key });
    });

  // Change notices, never values: every listener re-reads GET /settings. No
  // replay — a reconnect is itself the signal to re-read, which closes any gap.
  app.get('/settings/events', { schema: { ...TAG,
    summary: 'Settings change events',
    description: 'ND-JSON, open until the client hangs up: {event:"settings_changed",scope,client?} after a write, ' +
      'plus {event:"heartbeat"}. The record carries no setting values — listeners re-read /settings.' } },
    async (req, reply) => {
      reply.raw.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const write = (record: unknown) => { reply.raw.write(`${JSON.stringify(record)}\n`); };
      const heartbeat = setInterval(() => write({ event: 'heartbeat' }), 15_000);
      // The feed is the whole server's; a user hears of the layers they read:
      // global (names only — values never ride here), their organization's,
      // their own, and the projects the policies let them see.
      const caller = req.caller;
      const who = acting();
      const reads = async (scope: string): Promise<boolean> => {
        if (caller?.type !== 'user' || !who) return true;
        if (scope === GLOBAL) return true;
        if (scope === organizationScope(caller.organization.id) || scope === userScope(caller.user.id)) return true;
        if (scope.startsWith('project:')) return actAs(who, () => ctx.projects.get(scope.slice('project:'.length))).then(Boolean, () => false);
        return false;
      };
      const unsubscribe = ctx.settingsEvents.subscribe((change) => { void reads(change.scope).then((yes) => { if (yes) write(change); }); });
      write({ event: 'heartbeat' });
      await new Promise<void>((resolve) => reply.raw.on('close', resolve));
      clearInterval(heartbeat);
      unsubscribe();
      return reply;
    });
}
