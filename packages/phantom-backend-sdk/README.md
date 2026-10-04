# phantom-backend-sdk

What a phantom backend runs. `PhantomBackend.create(config)` builds every
service — database and migrations, settings, the table owners, the agent
registry, the runtime, git, Telegram plumbing, the API — and `start()` runs
it. An app hands in a config (its settings, agent types, tools, routes, git
hooks, `onStart`/`onStop`) and never subclasses; it reaches the backend
through the config and the backend's public objects, nothing else.

Final package name: `@phantom-agent-sdk/backend` (docs/v1-plan.md §2).

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
npm run backend-sdk:build
npm run backend-sdk:lint
```
