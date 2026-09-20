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
  CREDENTIALS, CREDENTIAL_NAMES, type CredentialMeta, credentialMeta,
  isWorkspaceOverridable, isCredentialWorkspaceScoped, isGlobalSettable,
  SettingsWriteError, type SettingKey,
  DEFAULTS, DESCRIPTIONS, META,
} from '../../settings.js';
import { GLOBAL, workspaceScope } from '../../store.js';
import { sessionPin, type AgentName } from '../../agentConfig.js';
import { AGENT_NAMES } from '../../../core/llm/agentConfig.js';
import { ok, err, type AppCtx } from '../app.js';

const writerOf = (req: FastifyRequest): string | undefined =>
  String(req.headers['x-phantom-looper-client'] ?? '') || undefined;

const TAG = { tags: ['settings'] };
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
        out[name] = {
          default: null, global: g, workspace: w,
          value: w ?? g, source: w != null ? 'workspace' : g != null ? 'global' : 'default',
          secret: true, description: (CREDENTIALS[name] as CredentialMeta).description,
          meta: credentialMeta(name),
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
      // Every write lands on the settings feed (Settings.write): the looper
      // and the Telegram engine listen there, whichever door wrote.
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
      return ok({ cleared: req.params.key });
    });

  // The finished answer to "how does agent X run right now" — model, key,
  // steps, compaction — for a remote client that runs the agent itself (the
  // cli). The SAME door the server's own engines use (Settings.agentConfig),
  // so the cli holds no copy of the cascade or the pin rule and never
  // downloads every key to build one agent. Returns the key, like GET
  // /settings does: the caller is going to call the provider with it.
  app.get<{ Params: { agent: string }; Querystring: { session?: string; workspace?: string } }>(
    '/agents/:agent/config', { schema: { ...TAG,
      summary: "An agent's runtime configuration, resolved",
      description: 'The model (provider, model, endpoint, key, reasoning), steps per turn and compaction settings ' +
        'for `agent` (coding | assistant | supervisor), resolved from the settings exactly as the server resolves them ' +
        'for its own turns. Pass ?session= to apply that session\'s pinned model and its workspace\'s overrides; ' +
        '?workspace= for a workspace\'s overrides alone.',
      params: { type: 'object', properties: { agent: { type: 'string', enum: [...AGENT_NAMES] } } },
      querystring: { type: 'object', properties: {
        session: { type: 'string' }, workspace: { type: 'string' } } } } },
    async (req, reply) => {
      const agent = req.params.agent as AgentName;
      const session = req.query.session ? await ctx.sessions.get(req.query.session) : undefined;
      if (req.query.session && !session) return reply.code(404).send(err('session_not_found', `no session ${req.query.session}`));
      const workspaceId = session?.workspaceId ?? req.query.workspace;
      const workspace = workspaceId ? await ctx.workspaces.get(workspaceId) : undefined;
      if (workspaceId && !workspace) return reply.code(404).send(err('not_found', `no workspace ${workspaceId}`));
      try {
        return ok(await ctx.settings.agentConfig(agent, { workspace, pin: sessionPin(session) }));
      } catch (e) {
        // A half-set pair (a provider override with no model): the fix is in
        // the message, and it is the caller's settings to fix.
        return reply.code(400).send(err('agent_config_invalid', (e as Error).message));
      }
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
