// The settings store.
//
//   GET    /settings           every setting, resolved with its layers
//   PATCH  /settings           write; null clears a key
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
  type Scope = { error: string } | { scope: SettingScope; write: string; layer: Layer };
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
    const layer: Layer = query.project ? 'project' : query.user ? 'user' : query.organization ? 'organization' : 'global';
    return { scope, write: scopeNames(scope)[layer] ?? GLOBAL, layer };
  }

  app.get<{ Querystring: ScopeQuery }>(
    '/settings', { schema: { ...TAG,
      summary: 'List settings',
      description: 'Every setting with its current value, where that value comes from (the default, the server, an organization, a user, a project, or fixed), and what is needed to show an editor for it. Add `organization`, `user` or `project` to see the values for that scope. A user sees only the settings they can change.',
      querystring: scopeQuery } },
    async (req, reply) => {
      const where = await scopeFor(req);
      if ('error' in where) return reply.code(404).send(err('not_found', where.error));
      const entries = await ctx.settings.layersForScope(where.scope);
      const credentials = await ctx.settings.credentialLayers(where.scope);
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(entries)) {
        // A project-only key has no global meaning — the global list omits it.
        if (where.layer === 'global' && !ctx.settings.isGlobalSettable(key)) continue;
        // A user sees what they could act on: keys settable below global.
        // The server's own (limits, mail, the console) are the service role's.
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
      summary: 'Change settings',
      description: 'Sets one or more settings, sent as `{key: value}`. A `null` value clears a setting, so it falls back to the next layer up. Add `organization`, `user` or `project` to change that scope instead of the server-wide value. Settings a scope cannot hold, and fixed settings, are refused.',
      querystring: scopeQuery,
      body: { type: 'object', additionalProperties: true } } },
    async (req, reply) => {
      const scope = await scopeFor(req);
      if ('error' in scope) return reply.code(404).send(err('not_found', scope.error));
      let updated: string[];
      try {
        updated = await ctx.settings.writeAtScope(scope.layer, scope.write, req.body ?? {}, writerOf(req));
      } catch (error) {
        if (error instanceof SettingsWriteError) return error.code === 'fixed' ? reply.code(403).send(err('access_denied', 'access denied')) : reply.code(400).send(err(error.code, error.message));
        throw error;
      }
      // Every write lands on the settings feed (Settings.write): the looper
      // and the Telegram engine listen there, whichever door wrote.
      return ok({ updated });
    });

  // Change notices, never values: every listener re-reads GET /settings. No
  // replay — a reconnect is itself the signal to re-read, which closes any gap.
  app.get('/settings/events', { schema: { ...TAG,
    summary: 'Stream settings changes',
    description: 'A live stream, one JSON object per line, announcing each settings change: which scope changed and which keys. It carries no values; read the settings again when one arrives. It stays open until you disconnect.' } },
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
