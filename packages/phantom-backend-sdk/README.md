# @phantom@phantom-agent-sdk/backend

What a phantom server runs. `PhantomBackend.create(config)` builds every
service; `start()` runs it. User space hands in a config — its settings,
agent types, tools, routes and hooks — and never subclasses.

Status: stubs. Every object's public surface is declared with a one-line
doc; bodies move in one object at a time (docs/phantom-agent-sdk-plan.md).

```
src/PhantomBackend.ts     the root: members, boot order, start/stop
src/doors.ts             what user space registers: settings, agent types, tools, routes
src/members.ts           the 45 members, one file each
src/storage/             Database, Settings, the table owners, AgentDatabases
src/agents/              AgentTypes, AgentConfig, SystemPrompt, ModelCatalog, SessionTitler, UserMessageQueue, Tools, the feeds
src/runtime/             Docker, Images, SessionContainers, Sandbox, CheckoutPool, Disk, Skills, SystemSkills, Web
src/git/                 Git, GitSync, InstantSync, WorkspaceWatcher, GitHub, CommitMessages
src/telegram/            TelegramBot, TelegramRenderer, TelegramAttachments, TelegramVoice, TelegramApprovals, TelegramDedupe
src/api/                 HttpApi, DbConsole
```
