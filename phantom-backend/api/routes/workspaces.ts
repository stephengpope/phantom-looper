import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { workspaces, sessions, sessionColumns, settings as settingsTable } from '../../db/schema.js';
import { parseRepoRef, remoteUrl } from '../../git/remote.js';
import { createRepo, listRepos, whoami } from '../../git/github.js';
import { initializeRemote, classifyGitFailure } from '../../git/git.js';
import { settingsBlock, validatePatch, resolveCredential, isWorkspaceOverridable,
  type SettingKey } from '../../settings.js';
import { putScoped, dropKey, readKey, workspaceScope } from '../../store.js';
import { newId } from '../../../core/ids.js';
import { ensureWorkspaceSchema, dropWorkspaceSchema } from '../../db/workspaceSchema.js';
import { prefixOf } from './kanban.js';
import { resolveAuth } from '../../pool/pool.js';
import { ok, err, type AppCtx } from '../app.js';

/** What leaves the API. The credential is no longer a column — it is
 *  `github_token` at this workspace's scope, so hasCredential is a lookup. */
function publicWorkspace(r: typeof workspaces.$inferSelect, hasCredential = false) {
  const { displayName, ...rest } = r;
  // displayName: what humans call it; falls back to the GitHub name.
  return { ...rest, displayName: displayName ?? r.name, hasCredential };
}

const TAG = { tags: ['workspaces'] };
const idParam = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };

export function workspaceRoutes(app: FastifyInstance, ctx: AppCtx) {
  // The stored github_token, checked against GitHub itself — what the /keys
  // screen calls right after a save, so a dead or mistyped token is caught
  // where it was pasted instead of at the next clone. Reads the GLOBAL layer
  // (the one /keys writes); a workspace's own token is exercised by its
  // workspace's operations.
  app.get('/github/whoami', { schema: { tags: ['system'],
    summary: 'Verify the stored github_token against GitHub',
    description: 'Resolves the global github_token and asks GitHub whose it is. ' +
      '404 when none is stored; the classified error when GitHub rejects it.' } },
  async (_req, reply) => {
    const pat = await resolveCredential(ctx.db, ctx.encryptionKey, 'github_token');
    if (!pat) return reply.code(404).send(err('not_set', 'no github_token stored'));
    const who = await whoami(pat);
    if (!who.ok) {
      return reply.code(who.code === 'upstream_unreachable' ? 502 : 400)
        .send(err(who.code, who.message, who.code === 'upstream_unreachable'));
    }
    return ok({ login: who.login });
  });

  // What the stored github_token can see, for the "add an existing repo"
  // picker: every repository the token reaches, newest push first, each
  // marked `added` when a workspace already points at it — POST /workspaces
  // has no uniqueness rule, so the list is where a duplicate is prevented.
  app.get('/github/repos', { schema: { tags: ['system'],
    summary: 'Repositories the stored github_token can see',
    description: 'Pages GitHub\'s /user/repos (owner, collaborator, organization member; sorted by last push) ' +
      'with the GLOBAL github_token. Each row: owner, name, private, defaultBranch, pushedAt, and `added` — ' +
      'whether a workspace is already registered for it. 404 when no token is stored; the classified error ' +
      'when GitHub rejects it.' } },
  async (_req, reply) => {
    const pat = await resolveCredential(ctx.db, ctx.encryptionKey, 'github_token');
    if (!pat) return reply.code(404).send(err('not_set', 'no github_token stored'));
    const listed = await listRepos(pat);
    if (!listed.ok) {
      return reply.code(listed.code === 'upstream_unreachable' ? 502 : 400)
        .send(err(listed.code, listed.message, listed.code === 'upstream_unreachable'));
    }
    const have = new Set((await ctx.db.select({ owner: workspaces.owner, name: workspaces.name }).from(workspaces))
      .map((w) => `${w.owner}/${w.name}`.toLowerCase()));
    return ok(listed.repos.map((r) => ({ ...r, added: have.has(`${r.owner}/${r.name}`.toLowerCase()) })));
  });

  app.get('/workspaces', { schema: { ...TAG, summary: 'List workspaces',
    description: 'All registered workspaces with hasCredential flags and `cardPrefix` (the resolved card ' +
      'number prefix, e.g. "PHA"). Credentials are never returned by any route.' } }, async () => {
    const rows = await ctx.db.select().from(workspaces);
    return ok(await Promise.all(rows.map(async (r) => ({
      ...publicWorkspace(r, !!await readKey(ctx.db, ctx.encryptionKey, 'github_token', workspaceScope(r.id))),
      cardPrefix: await prefixOf(ctx.db, r),
    }))));
  });

  app.post<{ Body: { url: string; base_branch?: string; branch_prefix?: string;
    display_name?: string; create?: boolean; private?: boolean; description?: string; token?: string } }>(
    '/workspaces', { schema: { ...TAG, summary: 'Register a workspace (optionally creating it on GitHub)',
      description: 'Creates the workspace row, its SQL schema (files/links + agent tables), and makes it a pool target. ' +
        '`url` takes a plain GitHub URL or owner/name — embedded credentials are rejected. With create=true the repository is ' +
        'CREATED on GitHub first and seeded with an initial commit on base_branch; if it already exists the call ' +
        'fails (already_exists) — this is create, not create-if-missing. Creation uses `token` (stored as the ' +
        'workspace credential) or else the global github_token, and needs a token that can create repositories.',
      body: { type: 'object', required: ['url'], additionalProperties: false,
        examples: [
          { url: 'https://github.com/you/your-workspace', base_branch: 'main' },
          { url: 'https://github.com/you/new-workspace', create: true, private: true, token: 'ghp_can_create_repos' },
        ],
        properties: {
        url: { type: 'string', description: 'https://github.com/{owner}/{name} or owner/name; with create, a bare name creates under the token\'s account. Never with embedded credentials.' },
        display_name: { type: 'string', description: 'Human label. Defaults to the workspace name from the URL.' },
        base_branch: { type: 'string', default: 'main' },
        branch_prefix: { type: 'string', default: 'agent' },
        create: { type: 'boolean', default: false, description: 'Create the repository on GitHub. Fails if it already exists.' },
        private: { type: 'boolean', default: true, description: 'With create: visibility of the new repository.' },
        description: { type: 'string', description: 'With create: the GitHub repository description.' },
        token: { type: 'string', description: 'PAT to create with; stored as this workspace\'s github_token. Falls back to the global one.' } } } } },
    async (req, reply) => {
      // A bare name is enough to CREATE — the token says whose account. An
      // existing repo has to be named in full: there is nothing to derive
      // the owner from.
      let owner = '', name: string;
      try {
        const ref = parseRepoRef(req.body?.url ?? '');
        name = ref.name;
        owner = ref.owner ?? '';
      } catch (e) { return reply.code(400).send(err('invalid_url', (e as Error).message)); }
      if (!owner && !req.body.create) {
        return reply.code(400).send(err('invalid_url',
          'an existing repo needs owner/name or its URL — a bare name only works with create'));
      }
      const baseBranch = req.body.base_branch ?? 'main';

      let ownToken: string | undefined;
      if (req.body.create) {
        const pat = req.body.token ?? await resolveCredential(ctx.db, ctx.encryptionKey, 'github_token');
        if (!pat) return reply.code(400).send(err('credential_required', 'create needs `token` or the github_token credential'));
        if (!owner) {
          const who = await whoami(pat);
          if (!who.ok) {
            return reply.code(who.code === 'upstream_unreachable' ? 502 : 400)
              .send(err(who.code, who.message, who.code === 'upstream_unreachable'));
          }
          owner = who.login;
        }
        const created = await createRepo(pat, owner, name,
          { private: req.body.private ?? true, description: req.body.description });
        if (!created.ok) {
          const status = created.code === 'already_exists' ? 409 : created.code === 'upstream_unreachable' ? 502 : 400;
          return reply.code(status).send(err(created.code, created.message, created.code === 'upstream_unreachable'));
        }
        // The new workspace is empty. Seed base_branch now so every clone path works.
        try {
          await initializeRemote(created.cloneUrl, baseBranch, { url: created.cloneUrl, pat },
            `# ${name}\n\nCreated by phantom-looper.\n`);
        } catch (e) {
          // The workspace exists now but is empty. Say exactly what stopped the seed
          // so the operator can fix the token and re-run with create=false.
          const why = classifyGitFailure(e, { hadToken: true });
          const msg = why?.message ?? String((e as { stderr?: string }).stderr ?? (e as Error).message).trim().slice(0, 200);
          return reply.code(why?.code === 'upstream_unreachable' ? 502 : 400).send(
            err(why?.code ?? 'error', `repository created on GitHub but the initial push to ${baseBranch} failed (${msg}). ` +
              `Fix the token's contents:write permission and register it again without create.`, why?.retryable ?? false));
        }
        if (req.body.token) ownToken = req.body.token;
      }

      const id = newId();
      const row = {
        id, url: remoteUrl(owner, name), owner, name,
        displayName: req.body.display_name?.trim() || null,
        baseBranch,
        branchPrefix: req.body.branch_prefix ?? 'agent',
        schemaName: `wsp_${id}`,
      };
      await ctx.db.insert(workspaces).values(row);
      // A token handed to create= belongs to this workspace: `github_token` at
      // its own scope, the same key the global one uses one layer down.
      if (ownToken) {
        await putScoped(ctx.db, ctx.encryptionKey, workspaceScope(id), 'github_token', ownToken, true);
      }
      await ensureWorkspaceSchema(ctx.pgPool, id, row.schemaName);
      const created = await ctx.db.select().from(workspaces).where(eq(workspaces.id, id));
      return reply.code(201).send(ok(publicWorkspace(created[0], !!ownToken)));
    });

  app.get<{ Params: { id: string } }>('/workspaces/:id', { schema: { ...TAG,
    summary: 'One workspace, settings resolved',
    description: 'The workspace row (hasCredential; the credential itself is never returned), `cardPrefix` ' +
      '(the resolved card number prefix, e.g. "PHA" — the same value the list route returns) plus `settings`: ' +
      'every setting with its LAYERS — `default` (code), `global` (the settings row, null when unset), ' +
      '`workspace` (this workspace\'s override, null when unset), and the computed `value` + `source` — ' +
      'with `description`, `meta` and `overridable` per key, so a client renders a per-workspace editor ' +
      'from this one call. `overridable: false` means global-only: PATCH will not accept it. ' +
      'The first question to ask when the pool misbehaves.',
    params: idParam } }, async (req, reply) => {
    const rows = await ctx.db.select().from(workspaces).where(eq(workspaces.id, req.params.id));
    if (!rows.length) return reply.code(404).send(err('not_found', `no workspace ${req.params.id}`));
    return ok({
      ...publicWorkspace(rows[0],
        !!await readKey(ctx.db, ctx.encryptionKey, 'github_token', workspaceScope(rows[0].id))),
      // Same fact, same name as GET /workspaces: a client that reads one
      // workspace (the cli, opening a session) must not have to list them all
      // to learn how this workspace names its cards.
      cardPrefix: await prefixOf(ctx.db, rows[0]),
      settings: await settingsBlock(ctx.db, { workspace: rows[0] }) });
  });

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/workspaces/:id', { schema: { ...TAG, summary: 'Update workspace-level overrides',
      description: 'Workspace values override global settings (pool size, idle timers, history depth, workspace image). ' +
        'Every overridable field accepts null, which REMOVES the workspace value so the setting follows the global one ' +
        'again — a different state from setting it to whatever the global value happens to be today. base_branch and ' +
        'branch_prefix are the workspace\'s own, not overrides, and cannot be nulled.', params: idParam,
      body: { type: 'object', additionalProperties: false, properties: {
        display_name: { type: 'string', description: 'Human label; empty string reverts to the workspace name.' },
        base_branch: { type: 'string' }, branch_prefix: { type: 'string' },
        spare_clones: { type: ['integer', 'null'] },
        // Same column, two names: `session_idle_destroy_ms` is what the setting
        // is called everywhere else, so a client rendering the `settings` block
        // on the GET can PATCH the key it was handed.
        session_idle_destroy_ms: { type: ['integer', 'null'] },
        idle_destroy_ms: { type: ['integer', 'null'], description: 'Alias of session_idle_destroy_ms.' },
        initial_history_depth: { type: ['string', 'null'], examples: ['7.days', 'full'] },
        container_image: { type: ['string', 'null'] },
        agent_git_credentials: { type: ['boolean', 'null'],
          description: 'Put this workspace\'s GitHub PAT in the container so the agent\'s git and gh are authenticated.' },
        auto_push_on_archive: { type: ['boolean', 'null'],
          description: 'Whether archiving a done card auto-pushes its session\'s work to the base branch.' },
        card_prefix: { type: ['string', 'null'],
          description: 'Kanban card number prefix ("PHA-7"). null reverts to the default: the first 3 letters of the repo name.' } } } } },
    async (req, reply) => {
      const rows0 = await ctx.db.select().from(workspaces).where(eq(workspaces.id, req.params.id));
      if (!rows0.length) return reply.code(404).send(err('not_found', `no workspace ${req.params.id}`));
      const body = req.body ?? {};

      // Three fields are the workspace's OWN — no global to fall back to, so
      // they are columns, not overrides, and cannot be cleared. Everything else
      // is a setting at this workspace's layer.
      const OWN: Record<string, string> = {
        display_name: 'displayName', base_branch: 'baseBranch', branch_prefix: 'branchPrefix' };

      // `idle_destroy_ms` is the same setting under an older name.
      const asSetting = (k: string) => (k === 'idle_destroy_ms' ? 'session_idle_destroy_ms' : k);
      const settingEntries = Object.entries(body).filter(([k]) => !(k in OWN))
        .map(([k, v]) => [asSetting(k), v] as [string, unknown]);

      // The SAME validator PATCH /settings runs. Without it the two doors
      // disagreed: spare_clones: -5 was refused globally and stored here, and
      // session_idle_destroy_ms: -1 made every session in the workspace read as
      // idle, so the next sweep deleted every clone.
      const invalid = validatePatch(settingEntries);
      if (invalid.length) return reply.code(400).send(err('invalid_setting', invalid.join('; ')));
      const notHere = settingEntries.filter(([k]) => !isWorkspaceOverridable(k as SettingKey)).map(([k]) => k);
      if (notHere.length) {
        return reply.code(400).send(err('not_overridable', `${notHere.join(', ')} cannot be set per workspace`));
      }

      const patch: Record<string, unknown> = {};
      for (const [k, column] of Object.entries(OWN)) if (k in body) patch[column] = body[k];
      if (patch.displayName === '') patch.displayName = null; // empty reverts to the default
      // Fastify runs ajv with coerceTypes, which turns null into "" for a
      // `type: 'string'` field — so "clear the base branch" would land as a
      // workspace whose base branch is the empty string. Refuse it here, where
      // the value is what will be stored.
      for (const [field, column] of [['base_branch', 'baseBranch'], ['branch_prefix', 'branchPrefix']] as const) {
        if (column in patch && !String(patch[column] ?? '').trim()) {
          return reply.code(400).send(err('not_nullable',
            `${field} cannot be cleared — it is this workspace's own, not an override`));
        }
      }
      if (!Object.keys(patch).length && !settingEntries.length) {
        return reply.code(400).send(err('empty_patch', 'nothing to update'));
      }
      if (Object.keys(patch).length) {
        await ctx.db.update(workspaces).set(patch).where(eq(workspaces.id, req.params.id));
      }
      // null clears the override — one rule at every layer.
      for (const [k, v] of settingEntries) {
        if (v === null) await dropKey(ctx.db, k, workspaceScope(req.params.id));
        else await putScoped(ctx.db, ctx.encryptionKey, workspaceScope(req.params.id), k, v, false);
      }
      const rows = await ctx.db.select().from(workspaces).where(eq(workspaces.id, req.params.id));
      return ok(publicWorkspace(rows[0],
        !!await readKey(ctx.db, ctx.encryptionKey, 'github_token', workspaceScope(req.params.id))));
    });

  // Refuses while sessions exist — the schema and workspaces it would orphan
  // are the agent's accumulated work, not cleanup.
  // Dropping the schema destroys the agent's accumulated tables — refuse while
  // sessions exist, and require the explicit confirm flag for the drop itself.
  app.delete<{ Params: { id: string }; Querystring: { confirm?: string } }>(
    '/workspaces/:id', { schema: { ...TAG,
      summary: 'Delete a workspace',
      description: 'Refuses while sessions are active. Dropping the schema destroys every agent table in it, so the drop additionally requires ?confirm=true.',
      params: idParam, querystring: { type: 'object', properties: { confirm: { type: 'string', enum: ['true'] } } } } },
    async (req, reply) => {
      const live = await ctx.db.select(sessionColumns).from(sessions)
        .where(and(eq(sessions.workspaceId, req.params.id), eq(sessions.status, 'active')));
      if (live.length) return reply.code(409).send(err('sessions_exist', `${live.length} active session(s)`));
      const rows = await ctx.db.select().from(workspaces).where(eq(workspaces.id, req.params.id));
      if (rows.length && req.query.confirm === 'true') {
        await dropWorkspaceSchema(ctx.pgPool, rows[0].schemaName);
      } else if (rows.length) {
        return reply.code(409).send(err('confirm_required',
          'deleting a workspace drops its schema and every agent table in it — pass ?confirm=true'));
      }
      // Its overrides and its own token go with it — a scope whose workspace is
      // gone is a row nothing will ever read again.
      await ctx.db.delete(settingsTable).where(eq(settingsTable.scope, workspaceScope(req.params.id)));
      await ctx.db.delete(workspaces).where(eq(workspaces.id, req.params.id));
      return ok({ deleted: req.params.id });
    });

  // The workspace GitHub token, this workspace's own PAT and the global one are
  // ONE key at two layers — `github_token` global, `github_token` at
  // workspace:<id>. PATCH /settings?workspace=<id> writes it and null
  // clears it, exactly like every other override. The two routes that used to
  // do this by hand (PUT/DELETE /workspaces/:id/credential) are gone, and so is
  // /secrets: settings were readable and secrets were not, which is the only
  // reason they were ever two systems.

  // The old GET /workspaces/:id/effective is gone: the plain GET above returns
  // the resolved settings WITH their layers — the normal shape (git, VS Code:
  // the default read is the effective one; raw layers ride along, not apart).
}
