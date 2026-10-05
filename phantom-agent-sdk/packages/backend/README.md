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
`WORKSPACE_ROOT_PATH`, `PORT`, `API_KEY`, `ENCRYPTION_KEY`, `DOCKER_HOST`);
every behavioural knob is a setting, read over the API.

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
src/storage/             Database, Settings, the table owners, AgentDatabases, schema, migrations/
src/agents/              AgentTypes, AgentConfig, SystemPrompt, ModelCatalog, SessionTitler, UserMessageQueue, the feeds
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
