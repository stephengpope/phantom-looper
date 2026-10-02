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
import type { ProjectRow } from '../../storage/schema.js';
import { SettingsWriteError } from '../../storage/Settings.js';
import { GLOBAL, projectScope } from '../../lib/scopes.js';
import { ok, err } from '../HttpApi.js';
import type { PhantomBackend } from '../../PhantomBackend.js';

const writerOf = (req: FastifyRequest): string | undefined =>
  String(req.headers['x-phantom-looper-client'] ?? '') || undefined;

const TAG = { tags: ['settings'] };
const scopeQuery = { type: 'object', properties: {
  project: { type: 'string', description: 'Read/write at this project\'s layer.' },
} };

export function settingsRoutes(app: FastifyInstance, ctx: PhantomBackend) {
  /** The scope one request addresses. Verifying the project exists is what
   *  stops a typo becoming an override nothing will ever read — the row would
   *  be perfectly valid and perfectly dead. */
  type Scope = { error: string } | { write: string; kind: 'global' | 'project'; project?: ProjectRow };
  async function scopeOf(q: { project?: string }): Promise<Scope> {
    if (q.project) {
      const project = await ctx.projects.get(q.project);
      if (!project) return { error: `no project ${q.project}` };
      return { write: projectScope(q.project), kind: 'project' as const, project };
    }
    return { write: GLOBAL, kind: 'global' as const };
  }

  app.get<{ Querystring: { project?: string } }>(
    '/settings', { schema: { ...TAG,
      summary: 'Every setting, resolved',
      description: 'Every setting with its LAYERS — `default` (code), `global`, `project` — plus the computed `value` and `source` (the layer it came from), and `description`/`meta`/`overridable` so a client renders an editor from this one call. Pass ?project= to fill in that layer. Credentials come back decrypted, flagged `secret`.',
      querystring: scopeQuery } },
    async (req, reply) => {
      const sc = await scopeOf(req.query);
      if ('error' in sc) return reply.code(404).send(err('not_found', sc.error));
      const scope = sc.project ? { projectId: sc.project.id } : {};
      const entries = await ctx.settings.layersForScope(scope);
      const credentials = await ctx.settings.credentialLayers(scope);
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(entries)) {
        // A project-only key has no global meaning — the global list omits it.
        if (sc.kind === 'global' && !ctx.settings.isGlobalSettable(key)) continue;
        if (!entry.secret) { out[key] = { ...entry, secret: false }; continue; }
        // Credentials are keys of the same store — same table, same chain —
        // and this route answers them decrypted.
        const globalValue = credentials[key]?.global ?? null;
        const projectValue = sc.kind !== 'global' ? credentials[key]?.project ?? null : null;
        out[key] = { ...entry, global: globalValue, project: projectValue, value: projectValue ?? globalValue,
          source: projectValue != null ? 'project' : globalValue != null ? 'global' : 'default' };
      }
      return ok(out);
    });

  app.patch<{ Querystring: { project?: string }; Body: Record<string, unknown> }>(
    '/settings', { schema: { ...TAG,
      summary: 'Write settings',
      description: 'Body is {key: value}. null CLEARS a key — the same rule at every layer, and null is never a stored value. An empty string is a real empty string. ' +
        'Which keys are credentials is declared in code, so they are stored encrypted without any flag. Unknown keys are refused. ' +
        'Pass ?project= to write that project\'s layer; a key the project may not override is refused.',
      querystring: scopeQuery,
      body: { type: 'object', additionalProperties: true } } },
    async (req, reply) => {
      const sc = await scopeOf(req.query);
      if ('error' in sc) return reply.code(404).send(err('not_found', sc.error));
      let updated: string[];
      try {
        updated = await ctx.settings.writeAtScope(sc.kind, sc.write, req.body ?? {}, writerOf(req));
      } catch (e) {
        if (e instanceof SettingsWriteError) return reply.code(400).send(err(e.code, e.message));
        throw e;
      }
      // Every write lands on the settings feed (Settings.write): the looper
      // and the Telegram engine listen there, whichever door wrote.
      return ok({ updated });
    });

  app.delete<{ Params: { key: string }; Querystring: { project?: string } }>(
    '/settings/:key', { schema: { ...TAG,
      summary: 'Clear one key',
      description: 'Identical to PATCH with null. The setting reverts to the code default and follows it if the default changes later — a different state from being set to the same value.',
      params: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      querystring: scopeQuery } },
    async (req, reply) => {
      const sc = await scopeOf(req.query);
      if ('error' in sc) return reply.code(404).send(err('not_found', sc.error));
      try {
        await ctx.settings.writeAtScope(sc.kind, sc.write, { [req.params.key]: null }, writerOf(req));
      } catch (e) {
        if (e instanceof SettingsWriteError) return reply.code(400).send(err(e.code, e.message));
        throw e;
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
      const write = (o: unknown) => { reply.raw.write(`${JSON.stringify(o)}\n`); };
      const heartbeat = setInterval(() => write({ event: 'heartbeat' }), 15_000);
      const unsubscribe = ctx.settingsEvents!.subscribe(write);
      write({ event: 'heartbeat' });
      await new Promise<void>((resolve) => reply.raw.on('close', resolve));
      clearInterval(heartbeat);
      unsubscribe();
      return reply;
    });
}
