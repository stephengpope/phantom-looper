// The settings store.
//
//   GET    /settings           every setting, resolved with its layers
//   PATCH  /settings           write; null clears a key
//   DELETE /settings/:key      clear one
//   GET    /settings/events    change notices (no values — listeners re-read)
//
// Every key is declared in code (settings.ts) — defaults, types, descriptions,
// whether a workspace may override it. Unknown keys are refused: a store
// where every key is declared is what keeps a typo from becoming an override
// nothing reads. `?workspace=<id>` reads or writes that workspace's layer —
// THE door for workspace overrides (the cli's workspace screen, the token).
//
// Credentials are returned decrypted; which keys are credentials is declared
// in code (CREDENTIALS), never decided by a write.
import type { FastifyInstance } from 'fastify';
import type { FastifyRequest } from 'fastify';
import type { WorkspaceRow } from '../../db/schema.js';
import {
  CREDENTIALS, CREDENTIAL_NAMES,
  isWorkspaceOverridable, isCredentialWorkspaceScoped, isGlobalSettable,
  SettingsWriteError, type SettingKey,
  DEFAULTS, DESCRIPTIONS, META,
} from '../../settings.js';
import { GLOBAL, workspaceScope } from '../../store.js';
import { ok, err, type AppCtx } from '../app.js';

const writerOf = (req: FastifyRequest): string | undefined =>
  String(req.headers['x-phantom-looper-client'] ?? '') || undefined;

const TAG = { tags: ['settings'] };
/** The looper's two switches: a write or clear of either re-examines the board. */
const LOOP_SETTING_KEYS: readonly string[] = ['auto_plan', 'auto_build'];
// A telegram_* key or the bot token changed: the engine reconciles its
// webhook + command menu, event-driven like the looper.
const TELEGRAM_SETTING_KEYS: readonly string[] = [
  'telegram_enabled', 'telegram_authorized_user', 'telegram_bot_token'];
const scopeQuery = { type: 'object', properties: {
  workspace: { type: 'string', description: 'Read/write at this workspace\'s layer.' },
} };

export function settingsRoutes(app: FastifyInstance, ctx: AppCtx) {
  /** The scope one request addresses. Verifying the workspace exists is what
   *  stops a typo becoming an override nothing will ever read — the row would
   *  be perfectly valid and perfectly dead. */
  type Scope = { error: string } | { write: string; kind: 'global' | 'workspace'; workspace?: WorkspaceRow };
  async function scopeOf(q: { workspace?: string }): Promise<Scope> {
    if (q.workspace) {
      const workspace = await ctx.workspaces.get(q.workspace);
      if (!workspace) return { error: `no workspace ${q.workspace}` };
      return { write: workspaceScope(q.workspace), kind: 'workspace' as const, workspace };
    }
    return { write: GLOBAL, kind: 'global' as const };
  }

  app.get<{ Querystring: { workspace?: string } }>(
    '/settings', { schema: { ...TAG,
      summary: 'Every setting, resolved',
      description: 'Every setting with its LAYERS — `default` (code), `global`, `workspace` — plus the computed `value` and `source` (the layer it came from), and `description`/`meta`/`overridable` so a client renders an editor from this one call. Pass ?workspace= to fill in that layer. Credentials come back decrypted, flagged `secret`.',
      querystring: scopeQuery } },
    async (req, reply) => {
      const sc = await scopeOf(req.query);
      if ('error' in sc) return reply.code(404).send(err('not_found', sc.error));
      const resolveCtx = { workspace: sc.workspace };
      const layers = await ctx.settings.layers(resolveCtx);
      const creds = await ctx.settings.credentialLayers(resolveCtx);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
        // A workspace-only key has no global meaning — the global list omits it.
        if (sc.kind === 'global' && !isGlobalSettable(key)) continue;
        out[key] = { ...layers[key], secret: false, description: DESCRIPTIONS[key], meta: META[key],
          overridable: isWorkspaceOverridable(key) };
      }
      // Credentials are keys of the same store — same table, same chain.
      for (const name of CREDENTIAL_NAMES) {
        const g = creds[name].global;
        const w = sc.kind !== 'global' ? creds[name].workspace : null;
        const { label, group, description } = CREDENTIALS[name];
        out[name] = {
          default: null, global: g, workspace: w,
          value: w ?? g, source: w != null ? 'workspace' : g != null ? 'global' : 'default',
          secret: true, description,
          meta: { type: 'string', label, group, nullable: true },
          overridable: isCredentialWorkspaceScoped(name),
        };
      }
      return ok(out);
    });

  app.patch<{ Querystring: { workspace?: string }; Body: Record<string, unknown> }>(
    '/settings', { schema: { ...TAG,
      summary: 'Write settings',
      description: 'Body is {key: value}. null CLEARS a key — the same rule at every layer, and null is never a stored value. An empty string is a real empty string. ' +
        'Which keys are credentials is declared in code, so they are stored encrypted without any flag. Unknown keys are refused. ' +
        'Pass ?workspace= to write that workspace\'s layer; a key the workspace may not override is refused.',
      querystring: scopeQuery,
      body: { type: 'object', additionalProperties: true } } },
    async (req, reply) => {
      const sc = await scopeOf(req.query);
      if ('error' in sc) return reply.code(404).send(err('not_found', sc.error));
      let updated: string[];
      try {
        updated = await ctx.settings.write(sc.kind, sc.write, req.body ?? {}, writerOf(req));
      } catch (e) {
        if (e instanceof SettingsWriteError) return reply.code(400).send(err(e.code, e.message));
        throw e;
      }
      // Supervision flipped (either switch): the looper re-examines the
      // affected workspace — or every one, when the global layer changed.
      // Event-driven, no poll.
      if (updated.some((k) => LOOP_SETTING_KEYS.includes(k))) {
        ctx.looper?.runAllLoops(sc.workspace?.id);
      }
      if (updated.some((k) => TELEGRAM_SETTING_KEYS.includes(k))) {
        void ctx.telegram?.reconcile();
      }
      return ok({ updated });
    });

  app.delete<{ Params: { key: string }; Querystring: { workspace?: string } }>(
    '/settings/:key', { schema: { ...TAG,
      summary: 'Clear one key',
      description: 'Identical to PATCH with null. The setting reverts to the code default and follows it if the default changes later — a different state from being set to the same value.',
      params: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      querystring: scopeQuery } },
    async (req, reply) => {
      const sc = await scopeOf(req.query);
      if ('error' in sc) return reply.code(404).send(err('not_found', sc.error));
      try {
        await ctx.settings.write(sc.kind, sc.write, { [req.params.key]: null }, writerOf(req));
      } catch (e) {
        if (e instanceof SettingsWriteError) return reply.code(400).send(err(e.code, e.message));
        throw e;
      }
      if (LOOP_SETTING_KEYS.includes(req.params.key)) {
        ctx.looper?.runAllLoops(sc.workspace?.id);
      }
      if (TELEGRAM_SETTING_KEYS.includes(req.params.key)) void ctx.telegram?.reconcile();
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
