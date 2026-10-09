# @phantom-agent-sdk/backend

What a phantom backend runs. `PhantomBackend.create(config)` builds every
service — database and migrations, settings, the table owners, the agent
registry, the runtime, git, Telegram plumbing, the API — and `start()` runs
it. An app hands in a config (its settings, agent types, tools, routes, git
hooks, `onStart`/`onStop`) and never subclasses; it reaches the backend
through the config and the backend's public objects, nothing else.

```ts
import { PhantomBackend, type PhantomBackendConfig } from '@phantom-agent-sdk/backend';

const config: PhantomBackendConfig = {
  migrations: { dir: 'path/to/your/migrations', ledgerSchema: 'my_app' },   // your tables, your schema
  settings: [...], agentTypes: [...], tools: [...], routes: (api) => {...},
  onStart: async (backend) => { /* your engines, with the backend in hand */ },
};
const backend = await PhantomBackend.create(config);   // env → database → migrations (the SDK's, then yours) → services
await backend.start();                                 // the API listens; onStart ran
```

Boot-and-connect values come from the environment (`DATABASE_URL`,
`WORKSPACE_ROOT_PATH`, `PORT`, `SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`, `DOCKER_HOST`);
every behavioural knob is a setting, read over the API.

**Database roles.** `DATABASE_URL` is the bootstrap superuser's; boot uses it
once to make sure `migrator` (owns every schema and table; runs the
migrations) and `service_role` (the process: rows only, no DDL; makes agent
play-space databases) exist with passwords derived from `ENCRYPTION_KEY`,
then hangs up. Nothing running can alter a table.

**Routes.** `/api/*` the SDK's — every object the backend builds, the
server's own update, logs, status and model catalog among them; a key, a
user role key or a sign-in token on every one, `serviceRole` routes the
key alone; `/api/auth/*` sign-in (Better Auth, with `config.identity`);
`/app/*` user space's (`config.routes`), no key check — the app gates each
with `backend.identity.require(request)`. `/db` the database console,
`/docs` the API's docs. The app's say in an SDK route is a config hook:
`config.deployment` names the images a release tag pulls, how the stack is
replaced (`sidecarApply` for the updater sidecar) and when a restart waits.

**Mail and sign-in.** `backend.mailer` sends over SMTP (the `smtp_*`
settings; `POST /api/mail/test` proves them). `config.identity` turns sign-in
on: magic links, invite-only; every user has a personal organization and an
invitation adds membership in another; a cli carries the session token as a
bearer, a program an API key. `backend.identity.callerOf(request)` says who
is calling — the service role or a user in their organization. The service role
bootstraps the first user with `POST /api/identity/users` and
`POST /api/identity/magic-link`. docs/multi-user.md has the whole of it.

**Storage.** The SDK's tables live in the Postgres schema `phantom_agent_sdk`
with their own migration ledger (`migrations/`, shipped in this package, run
by `Database.migrate` at boot). An app's tables live in the app's schema with
the app's folder and ledger (`config.migrations`). No app column on an SDK
table.

**Lockstep.** `GET /health` answers `sdk_version`; a client SDK on another
version refuses the backend. `src/sdkVersion.ts` carries the number beside
`package.json`; the build fails when they differ.

```
src/PhantomBackend.ts    the root: members, boot order, start/stop
src/doors.ts             what an app registers: settings, agent types, tools, routes
src/members.ts           the members, one file each
src/storage/             Database (roles, pool, migrations), Settings, the table owners, AgentDatabases, schema, migrations/
src/mail/                Mailer (SMTP)
src/identity/            Identity: Better Auth, who a caller is
src/agents/              AgentTypes, AgentConfig, SystemPrompt, ModelCatalog, SessionTitler, SessionNotes, the feeds
src/runtime/             Docker, Images, SessionContainers, Sandbox, CheckoutPool, Disk, Skills, SystemSkills, Web
src/git/                 Git, GitService, GitSync, InstantSync, WorkspaceWatcher, GitHub
src/telegram/            TelegramBot, TelegramApi, attachments, voice, approvals, the tables
src/tools/               the tool surface, defined once, published per agent type
src/api/                 HttpApi and the routes
src/upgrade/             Deployment (the compose stack: update, logs, restart, status), UpgradeChecker
```

```
npm run backend-sdk:build   # from the repo root
npm run backend-sdk:test    # node's runner over src/**/*.test.ts
npm run backend-sdk:lint
```
