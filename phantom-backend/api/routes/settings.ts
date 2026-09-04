// The settings store, flat — no namespace dimension.
//
//   GET    /settings           every setting, resolved with its layers
//   PATCH  /settings           write; null clears a key
//   DELETE /settings/:key      clear one
//
// Every key is declared in code (settings.ts) — defaults, types, descriptions,
// which layers it accepts. Unknown keys are refused: a store where every key
// is declared is what keeps a typo from becoming an override nothing reads.
//
// Secrets are returned decrypted; which keys are secret is declared in code
// (CREDENTIALS), never decided by a write.
import type { FastifyInstance } from 'fastify';
import {
  CREDENTIALS, CREDENTIAL_NAMES,
  isSettingKey, isCredential, isWorkspaceOverridable, isSessionOverridable,
  isCredentialWorkspaceScoped, isGlobalSettable, validatePatch, settingsLayers, type SettingKey,
  DEFAULTS, DESCRIPTIONS, META,
} from '../../settings.js';
import {
  readStore, putScoped, dropKey,
  GLOBAL, workspaceScope, sessionScope,
} from '../../store.js';
import { workspaces, sessions, sessionColumns } from '../../db/schema.js';
import { eq } from 'drizzle-orm';
import { ok, err, type AppCtx } from '../app.js';

const TAG = { tags: ['settings'] };
/** The looper's two switches: a write or clear of either re-examines the board. */
const LOOP_SETTING_KEYS: readonly string[] = ['auto_plan', 'auto_build'];
// A telegram_* key or the bot token changed: the engine reconciles its
// webhook + command menu, event-driven like the looper.
const TELEGRAM_SETTING_KEYS: readonly string[] = [
  'telegram_enabled', 'telegram_authorized_user', 'telegram_bot_token'];
const scopeQuery = { type: 'object', properties: {
  workspace: { type: 'string', description: 'Read/write at this workspace\'s layer.' },
  session: { type: 'string', description: 'Read/write at this session\'s layer.' },
} };

export function settingsRoutes(app: FastifyInstance, ctx: AppCtx) {
  /** The scope one request addresses, and the chain to read for it. Verifying
   *  the id exists is what stops a typo becoming an override nothing will ever
   *  read — the row would be perfectly valid and perfectly dead. */
  type Scope = { error: string } | { write: string; kind: 'global' | 'workspace' | 'session'; chain: string[] };
  async function scopeOf(q: { workspace?: string; session?: string }): Promise<Scope> {
    if (q.session) {
      const rows = await ctx.db.select(sessionColumns).from(sessions).where(eq(sessions.id, q.session));
      if (!rows.length) return { error: `no session ${q.session}` };
      const ws = await ctx.db.select().from(workspaces).where(eq(workspaces.id, rows[0].workspaceId));
      return { write: sessionScope(q.session), kind: 'session' as const,
        chain: [GLOBAL, ...(ws[0] ? [workspaceScope(ws[0].id)] : []), sessionScope(q.session)] };
    }
    if (q.workspace) {
      const rows = await ctx.db.select().from(workspaces).where(eq(workspaces.id, q.workspace));
      if (!rows.length) return { error: `no workspace ${q.workspace}` };
      return { write: workspaceScope(q.workspace), kind: 'workspace' as const,
        chain: [GLOBAL, workspaceScope(q.workspace)] };
    }
    return { write: GLOBAL, kind: 'global' as const, chain: [GLOBAL] };
  }

  app.get<{ Querystring: { workspace?: string; session?: string } }>(
    '/settings', { schema: { ...TAG,
      summary: 'Every setting, resolved',
      description: 'Every setting with its LAYERS — `default` (code), `global`, `workspace`, `session` — plus the computed `value` and `source`, and `description`/`meta`/`overridable` so a client renders an editor from this one call. Pass ?workspace= or ?session= to fill in those layers. Credentials come back decrypted, flagged `secret`.',
      querystring: scopeQuery } },
    async (req, reply) => {
      const sc = await scopeOf(req.query);
      if ('error' in sc) return reply.code(404).send(err('not_found', sc.error));
      const byScope = await readStore(ctx.db, ctx.encryptionKey, sc.chain);
      const at = (scope: string, k: string) => byScope.get(scope)?.get(k);

      const wsRow = req.query.workspace
        ? (await ctx.db.select().from(workspaces).where(eq(workspaces.id, req.query.workspace)))[0] : undefined;
      const sRow = req.query.session
        ? (await ctx.db.select(sessionColumns).from(sessions).where(eq(sessions.id, req.query.session)))[0] : undefined;
      const layers = await settingsLayers(ctx.db, { workspace: wsRow, session: sRow });
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(DEFAULTS) as SettingKey[]) {
        // A workspace-only key has no global meaning — the global list omits it.
        if (sc.kind === 'global' && !isGlobalSettable(key)) continue;
        out[key] = { ...layers[key], secret: false, description: DESCRIPTIONS[key], meta: META[key],
          overridable: isWorkspaceOverridable(key) };
      }
      // Credentials are keys of the same store — same table, same chain.
      for (const name of CREDENTIAL_NAMES) {
        const g = at(GLOBAL, name)?.value ?? null;
        const w = sc.kind !== 'global' ? at(workspaceScope(req.query.workspace ?? ''), name)?.value ?? null : null;
        out[name] = {
          default: null, global: g, workspace: w, session: null,
          value: w ?? g, source: w != null ? 'workspace' : g != null ? 'override' : 'default',
          secret: true, description: CREDENTIALS[name],
          meta: { type: 'string', label: name.replace(/_/g, ' '), nullable: true },
          overridable: isCredentialWorkspaceScoped(name),
        };
      }
      return ok(out);
    });

  app.patch<{ Querystring: { workspace?: string; session?: string };
    Body: Record<string, unknown> }>(
    '/settings', { schema: { ...TAG,
      summary: 'Write settings',
      description: 'Body is {key: value}. null CLEARS a key — the same rule at every layer, and null is never a stored value. An empty string is a real empty string. ' +
        'Which keys are secret is declared in code, so credentials are stored encrypted without any flag. Unknown keys are refused. ' +
        'Pass ?workspace= or ?session= to write that layer.',
      querystring: scopeQuery,
      body: { type: 'object', additionalProperties: true } } },
    async (req, reply) => {
      const body = req.body ?? {};
      const sc = await scopeOf(req.query);
      if ('error' in sc) return reply.code(404).send(err('not_found', sc.error));

      const entries = Object.entries(body).map(([k, value]) => ({ key: k, value }));
      const bad = entries.filter((e) => !isSettingKey(e.key) && !isCredential(e.key)).map((e) => e.key);
      if (bad.length) return reply.code(400).send(err('unknown_setting', `not settings: ${bad.join(', ')}`));
      const invalid = validatePatch(entries.filter((e) => !isCredential(e.key)).map((e) => [e.key, e.value] as [string, unknown]));
      if (invalid.length) return reply.code(400).send(err('invalid_setting', invalid.join('; ')));
      // A key may only be written at a layer it declares. Otherwise a typo'd
      // scope silently creates a row nothing will ever read.
      for (const e of entries) {
        if (sc.kind === 'global') {
          if (isSettingKey(e.key) && !isGlobalSettable(e.key)) {
            return reply.code(400).send(err('not_overridable',
              `${e.key} is a fact about one workspace — set it there`));
          }
          continue;
        }
        const okHere = isCredential(e.key)
          ? (sc.kind === 'workspace' && isCredentialWorkspaceScoped(e.key))
          : sc.kind === 'workspace' ? isWorkspaceOverridable(e.key as SettingKey)
            : isSessionOverridable(e.key as SettingKey);
        if (!okHere) {
          return reply.code(400).send(err('not_overridable',
            `${e.key} cannot be set per ${sc.kind}`));
        }
      }

      for (const e of entries) {
        if (e.value === null) { await dropKey(ctx.db, e.key, sc.write); continue; }
        // Secret-ness is a property of the key, declared in code.
        const secret = isCredential(e.key);
        if (secret && typeof e.value !== 'string') {
          return reply.code(400).send(err('invalid_args', `${e.key} must be a string to be stored as a secret`));
        }
        await putScoped(ctx.db, ctx.encryptionKey, sc.write, e.key, e.value, secret);
      }
      // Supervision flipped (either switch): the looper re-examines the
      // affected workspace — or every one, when the global layer changed.
      // Event-driven, no poll.
      if (entries.some((e) => LOOP_SETTING_KEYS.includes(e.key))) {
        ctx.looper?.runAllLoops(sc.kind === 'workspace' ? req.query.workspace : undefined);
      }
      if (entries.some((e) => TELEGRAM_SETTING_KEYS.includes(e.key))) {
        void ctx.telegram?.reconcile();
      }
      return ok({ updated: entries.map((e) => e.key) });
    });

  app.delete<{ Params: { key: string }; Querystring: { workspace?: string; session?: string } }>(
    '/settings/:key', { schema: { ...TAG,
      summary: 'Clear one key',
      description: 'Identical to PATCH with null. The setting reverts to the code default and follows it if the default changes later — a different state from being set to the same value.',
      params: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      querystring: scopeQuery } },
    async (req, reply) => {
      const sc = await scopeOf(req.query);
      if ('error' in sc) return reply.code(404).send(err('not_found', sc.error));
      await dropKey(ctx.db, req.params.key, sc.write);
      if (LOOP_SETTING_KEYS.includes(req.params.key)) {
        ctx.looper?.runAllLoops(sc.kind === 'workspace' ? req.query.workspace : undefined);
      }
      if (TELEGRAM_SETTING_KEYS.includes(req.params.key)) void ctx.telegram?.reconcile();
      return ok({ cleared: req.params.key });
    });
}
