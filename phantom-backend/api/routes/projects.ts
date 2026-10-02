import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ProjectRow } from 'phantom-backend-sdk/schema';
import { parseRepoRef, remoteUrl } from '../../git/remote.js';
import { createRepo, listRepos, whoami } from '../../git/github.js';
import { initializeRemote, classifyGitFailure } from '../../git/git.js';
import { ProjectError } from '../../projects.js';
import { projectScope } from '../../store.js';
import { newId } from '../../../core/ids.js';
import { ok, err, type AppCtx } from '../app.js';

/** What leaves the API. The credential is no longer a column — it is
 *  `github_token` at this project's scope, so hasCredential is a lookup. */
function publicProject(r: ProjectRow, hasCredential = false) {
  // nextCardNumber is the server's card-number counter, not a fact about the
  // project anyone edits or displays.
  const { displayName, nextCardNumber: _counter, ...rest } = r;
  // displayName: what humans call it; falls back to the GitHub name. url is
  // derived from owner + name, not stored.
  return { ...rest, url: remoteUrl(r.owner, r.name), displayName: displayName ?? r.name, hasCredential };
}

const TAG = { tags: ['projects'] };
const idParam = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
// Who wrote: the x-phantom-looper-client header every client sends, so the
// writer's own window ignores the change echo.
const writerOf = (req: FastifyRequest): string | undefined =>
  String(req.headers['x-phantom-looper-client'] ?? '') || undefined;

export function projectRoutes(app: FastifyInstance, ctx: AppCtx) {
  // The stored github_token, checked against GitHub itself — what the /keys
  // screen calls right after a save, so a dead or mistyped token is caught
  // where it was pasted instead of at the next clone. Reads the GLOBAL layer
  // (the one /keys writes); a project's own token is exercised by its
  // project's operations.
  app.get('/github/whoami', { schema: { tags: ['system'],
    summary: 'Verify the stored github_token against GitHub',
    description: 'Resolves the global github_token and asks GitHub whose it is. ' +
      '404 when none is stored; the classified error when GitHub rejects it.' } },
  async (_req, reply) => {
    const pat = await ctx.settings.credential('github_token');
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
  // marked `added` when a project already points at it — POST /projects
  // has no uniqueness rule, so the list is where a duplicate is prevented.
  app.get('/github/repos', { schema: { tags: ['system'],
    summary: 'Repositories the stored github_token can see',
    description: 'Pages GitHub\'s /user/repos (owner, collaborator, organization member; sorted by last push) ' +
      'with the GLOBAL github_token. Each row: owner, name, private, defaultBranch, pushedAt, and `added` — ' +
      'whether a project is already registered for it. 404 when no token is stored; the classified error ' +
      'when GitHub rejects it.' } },
  async (_req, reply) => {
    const pat = await ctx.settings.credential('github_token');
    if (!pat) return reply.code(404).send(err('not_set', 'no github_token stored'));
    const listed = await listRepos(pat);
    if (!listed.ok) {
      return reply.code(listed.code === 'upstream_unreachable' ? 502 : 400)
        .send(err(listed.code, listed.message, listed.code === 'upstream_unreachable'));
    }
    const have = new Set((await ctx.projects.list()).map((project) => `${project.owner}/${project.name}`.toLowerCase()));
    return ok(listed.repos.map((r) => ({ ...r, added: have.has(`${r.owner}/${r.name}`.toLowerCase()) })));
  });

  app.get('/projects', { schema: { ...TAG, summary: 'List projects',
    description: 'All registered projects with hasCredential flags and `cardPrefix` (the resolved card ' +
      'number prefix, e.g. "PHA"). Credentials are never returned by any route.' } }, async () => {
    const rows = await ctx.projects.list();
    return ok(await Promise.all(rows.map(async (r) => ({
      ...publicProject(r, await ctx.settings.hasAt('github_token', projectScope(r.id))),
      cardPrefix: await ctx.projects.prefixOf(r),
    }))));
  });

  app.post<{ Body: { url: string; base_branch?: string; branch_prefix?: string;
    display_name?: string; create?: boolean; private?: boolean; description?: string; token?: string } }>(
    '/projects', { schema: { ...TAG, summary: 'Register a project (optionally creating it on GitHub)',
      description: 'Creates the project row and makes it a pool target. ' +
        '`url` takes a plain GitHub URL or owner/name — embedded credentials are rejected. With create=true the repository is ' +
        'CREATED on GitHub first and seeded with an initial commit on base_branch; if it already exists the call ' +
        'fails (already_exists) — this is create, not create-if-missing. Creation uses `token` (stored as the ' +
        'project credential) or else the global github_token, and needs a token that can create repositories.',
      body: { type: 'object', required: ['url'], additionalProperties: false,
        examples: [
          { url: 'https://github.com/you/your-project', base_branch: 'main' },
          { url: 'https://github.com/you/new-project', create: true, private: true, token: 'ghp_can_create_repos' },
        ],
        properties: {
        url: { type: 'string', description: 'https://github.com/{owner}/{name} or owner/name; with create, a bare name creates under the token\'s account. Never with embedded credentials.' },
        display_name: { type: 'string', description: 'Human label. Defaults to the project name from the URL.' },
        base_branch: { type: 'string', default: 'main' },
        branch_prefix: { type: 'string', default: 'agent' },
        create: { type: 'boolean', default: false, description: 'Create the repository on GitHub. Fails if it already exists.' },
        private: { type: 'boolean', default: true, description: 'With create: visibility of the new repository.' },
        description: { type: 'string', description: 'With create: the GitHub repository description.' },
        token: { type: 'string', description: 'PAT to create with; stored as this project\'s github_token. Falls back to the global one.' } } } } },
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
        const pat = req.body.token ?? await ctx.settings.credential('github_token');
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
        // The new project is empty. Seed base_branch now so every clone path works.
        try {
          await initializeRemote(created.cloneUrl, baseBranch, { url: created.cloneUrl, pat },
            `# ${name}\n\nCreated by phantom-looper.\n`);
        } catch (e) {
          // The project exists now but is empty. Say exactly what stopped the seed
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
        id, owner, name,
        displayName: req.body.display_name?.trim() || null,
        baseBranch,
        branchPrefix: req.body.branch_prefix ?? 'agent',
      };
      let created;
      try {
        created = await ctx.projects.create(row, writerOf(req));
      } catch (e) {
        if (e instanceof ProjectError) return reply.code(409).send(err(e.code, e.message));
        throw e;
      }
      // A token handed to create= belongs to this project: `github_token` at
      // its own scope, the same key the global one uses one layer down.
      if (ownToken) await ctx.settings.write('project', projectScope(id), { github_token: ownToken }, writerOf(req));
      return reply.code(201).send(ok(publicProject(created, !!ownToken)));
    });

  app.get<{ Params: { id: string } }>('/projects/:id', { schema: { ...TAG,
    summary: 'One project, settings resolved',
    description: 'The project row (hasCredential; the credential itself is never returned), `cardPrefix` ' +
      '(the resolved card number prefix, e.g. "PHA" — the same value the list route returns) plus `settings`: ' +
      'every setting with its LAYERS — `default` (code), `global` (the settings row, null when unset), ' +
      '`project` (this project\'s override, null when unset), and the computed `value` + `source` — ' +
      'with `description`, `meta` and `overridable` per key, so a client renders a per-project editor ' +
      'from this one call. `overridable: false` means global-only: PATCH will not accept it. ' +
      'The first question to ask when the pool misbehaves.',
    params: idParam } }, async (req, reply) => {
    const project = await ctx.projects.get(req.params.id);
    if (!project) return reply.code(404).send(err('not_found', `no project ${req.params.id}`));
    return ok({
      ...publicProject(project, await ctx.settings.hasAt('github_token', projectScope(project.id))),
      // Same fact, same name as GET /projects: a client that reads one
      // project (the cli, opening a session) must not have to list them all
      // to learn how this project names its cards.
      cardPrefix: await ctx.projects.prefixOf(project),
      settings: await ctx.settings.block({ project }) });
  });

  // The project's OWN three fields — no global to fall back to, so they
  // are columns, not overrides, and cannot be cleared. Everything a project
  // may DIFFER on (spare clones, image, the looper switches, its token…) is a
  // setting at its layer: PATCH /settings?project=<id>, the one door. This
  // route used to accept settings too, with its own list of which — a list
  // that drifted from the real one and refused five of them.
  app.patch<{ Params: { id: string }; Body: { display_name?: string; base_branch?: string; branch_prefix?: string } }>(
    '/projects/:id', { schema: { ...TAG, summary: 'Update the project\'s own fields',
      description: 'display_name, base_branch, branch_prefix — the project\'s own, not overrides. ' +
        'base_branch and branch_prefix cannot be cleared; an empty display_name reverts to the repo name. ' +
        'Settings a project overrides are written with PATCH /settings?project=<id>.', params: idParam,
      body: { type: 'object', additionalProperties: false, properties: {
        display_name: { type: 'string', description: 'Human label; empty string reverts to the project name.' },
        base_branch: { type: 'string' }, branch_prefix: { type: 'string' } } } } },
    async (req, reply) => {
      if (!await ctx.projects.get(req.params.id)) return reply.code(404).send(err('not_found', `no project ${req.params.id}`));
      const body = req.body ?? {};
      const patch: Partial<Pick<ProjectRow, 'displayName' | 'baseBranch' | 'branchPrefix'>> = {};
      if (body.display_name !== undefined) patch.displayName = body.display_name || null; // empty reverts to the default
      if (body.base_branch !== undefined) patch.baseBranch = body.base_branch;
      if (body.branch_prefix !== undefined) patch.branchPrefix = body.branch_prefix;
      // Fastify runs ajv with coerceTypes, which turns null into "" for a
      // `type: 'string'` field — so "clear the base branch" would land as a
      // project whose base branch is the empty string. Refuse it here, where
      // the value is what will be stored.
      for (const [field, column] of [['base_branch', 'baseBranch'], ['branch_prefix', 'branchPrefix']] as const) {
        if (column in patch && !String(patch[column] ?? '').trim()) {
          return reply.code(400).send(err('not_nullable',
            `${field} cannot be cleared — it is this project's own, not an override`));
        }
      }
      if (!Object.keys(patch).length) return reply.code(400).send(err('empty_patch', 'nothing to update'));
      await ctx.projects.update(req.params.id, patch, writerOf(req));
      const updated = (await ctx.projects.get(req.params.id))!;
      return ok(publicProject(updated, await ctx.settings.hasAt('github_token', projectScope(req.params.id))));
    });

  // Refuses while sessions exist — they are the agent's accumulated work, not
  // cleanup. The row's cards and their history go with it (cascade), so the
  // delete itself needs the explicit confirm flag.
  app.delete<{ Params: { id: string }; Querystring: { confirm?: string } }>(
    '/projects/:id', { schema: { ...TAG,
      summary: 'Delete a project',
      description: 'Refuses while sessions are active. Requires ?confirm=true.',
      params: idParam, querystring: { type: 'object', properties: { confirm: { type: 'string', enum: ['true'] } } } } },
    async (req, reply) => {
      if (!await ctx.projects.get(req.params.id)) return reply.code(404).send(err('not_found', `no project ${req.params.id}`));
      // What stands in the way is files on disk (and their containers): the
      // workspaces still checked out. A conversation with no files of its own
      // — a supervisor's, the assistant's — blocks nothing.
      const live = await ctx.workspaces.countOnDisk(req.params.id);
      if (live) return reply.code(409).send(err('sessions_exist', `project ${req.params.id} still has ${live} active session(s) — close them first`));
      if (req.query.confirm !== 'true') {
        return reply.code(409).send(err('confirm_required', 'pass ?confirm=true'));
      }
      await ctx.projects.remove(req.params.id, writerOf(req));
      return ok({ deleted: req.params.id });
    });

  // The project GitHub token, this project's own PAT and the global one are
  // ONE key at two layers — `github_token` global, `github_token` at
  // project:<id>. PATCH /settings?project=<id> writes it and null
  // clears it, exactly like every other override.
}
