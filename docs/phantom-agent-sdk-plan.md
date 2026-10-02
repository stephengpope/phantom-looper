# phantom-agent-sdk — the plan

phantom-looper is a user-space app. It runs on **phantom-agent-sdk**: a
client SDK (`@phantom-agent-sdk/client`) that gives an app an agent and a
session, and a server SDK (`@phantom-agent-sdk/server`) that gives a server
the services, tables, API, auth and the framework to extend them. The SDK
supports; user space is one implementation of that support. This doc is
what is left to make that true, in order. It replaces `sdk-conversion.md`.

## Words

- **Project** — a registered repo: its base branch, branch prefix, board.
  Was "workspace".
- **Workspace** — a checkout: files on disk, a branch, a container. Was
  "folder". Every session on it (coder, supervisor, assistant) shares the
  container; `/workspace/repo` inside the container is this.
- **Session** — a conversation on a workspace.
- **Type** — which agent a session runs (`coding`, `supervisor`,
  `assistant`). User space declares types; the SDK knows a type only as a
  name it publishes tools and model config for.
- **The record** — the session's transcript on the server, typed lines.
- **The server's user message queue** — one-liners the server holds for a
  session's next turn, written into the record at turn-start.
- **Looper** — the card-run policy over the board. User space.

## Decided

- Two repos at the end: `phantom-agent-sdk` (the SDK, two packages,
  lockstep x.y.z, released together) and `phantom-looper` (the app, its own
  version line). Until it works the SDK lives here as
  `phantom-agent-sdk/` in the exact shape of its future repo, and is lifted
  out unchanged. No submodules, no publishing before then.
- Packages: `phantom-agent-sdk/packages/client`, `…/packages/server`;
  server depends on client (the record's line format). Two packages so a
  client-only app never installs `pg`, `dockerode`, `fastify`.
- Tables: the SDK's in schema `phantom_agent_sdk` with its own migrations
  and ledger, shipped in the server package; this app's in `phantom_looper`
  with its own. User space FKs into the SDK's tables at will. No user-space
  column on an SDK table. Drizzle shipped as the default; the user may
  bring their own.
- Server SDK includes: data owners, docker/images/containers/pool/disk,
  prompt assembly, agent config, models, skills, web, tools, the queue,
  events, git, the cron scheduler, Telegram plumbing (setup, linking, keys,
  webhook, rendering, voice, approval gates, dedupe/reply tables), the HTTP
  surface with auth and a door for user routes, CloudBeaver, the compose
  default (`COMPOSE_FILE` overrides), the api and workspace base images
  with a user-code insertion point, a setup entry, a way to upgrade itself.
- User space (this app): boot/composition, the looper, the three agents and
  their prompts, the bot's behaviour (commands, modes, personality), the
  idle digest, the app's upgrade system and images.
- The server's agents reach the API as clients: a `PhantomBackend` on Node
  fetch at loopback. The cli's HTTP/2-over-TLS socket is the cli's
  transport, not an SDK rule; streaming needs neither.
- A session has a transcript, a container, and a workspace (the checkout)
  inside it. The container is the session's (`SessionContainers`); a session
  that borrows a workspace runs inside the owner's container. The image is
  the **session image** (`phantom-backend-session`); `build/workspace/` becomes
  `build/session/` when the runtime moves.
- A workspace's id equals its first session's id today. Kept through the
  rename; splitting them is its own item later.
- No tests. Proof is a run on the real stack.

## 1. Rename

Two passes, two commits, a gate between: `workspace → project` until no
old-sense "workspace" remains, then `folder → workspace`. Tables, columns,
routes, settings scope values (`workspace:<id>` → `project:<id>`),
per-project databases (`workspace_<id>` → `project_<id>`), image names,
files, folders, objects, functions, variables, cli screens, prompts, docs.
Migration 047 moves live data. Already right and untouched: the container
path `/workspace`, `phantom-backend/workspace/`, `build/workspace/`,
container names `phantom-looper-ws-<id>`.

## 2. The SDK folder takes its final shape

`packages/phantom-client-sdk` → `phantom-agent-sdk/packages/client`
(`@phantom-agent-sdk/client`); `packages/phantom-server-sdk` →
`…/packages/server` (`@phantom-agent-sdk/server`). Dependency ranges
pinned (today's `*` is monorepo-only). The app imports by the new names.

## 3. Server SDK — the extension doors

The two registries user space declares into, before any table moves:
- **Settings registry** — names, defaults, labels, descriptions, groups;
  the SDK resolves and validates the app's alongside its own. Today
  defaults are hard-coded in `settings.ts`.
- **Agent-type registry** — the types an app runs; tools' `agents:` lists
  and per-type model settings derive from it. Today `AGENT_NAMES` is
  hard-coded in three places.

Then the schema split — `phantom_agent_sdk` + `phantom_looper`, one ledger
each — with the side tables that take user-space columns off SDK tables:
`card_automation` (`auto_plan`/`auto_build` off cards and projects),
`card_runs` (`card_id` off sessions), and `telegram_bot_state` split into
the SDK's link row (webhook, secret, bot username) and the app's behaviour
row (mode, active session, active project).

## 4. Server SDK — the services move in

Per the list under Decided. `phantom-backend` is left with its user-space
list. The HTTP surface moves with its auth and gains the door user space
registers routes through (the upgrade endpoint is the first user of it).

## 5. The server's agents onto the client SDK

- A loopback `PhantomBackend` in the server; `looper/injectFetch.ts` deleted.
- The card run opens `CodingAgent` / `SupervisorAgent` and adds its
  card-bound tools with `addToolKit()`; the run's move tool renamed (the
  server publishes `kanban_card_move` with another contract).
  `looper/turn.ts` goes.
- Cron runs the same way.
- The SDK's queue replaces `api/backdoor.ts`; turn-start drains it.
- `POST /sessions/:id/turn`, `core/session.ts`, `/sessions/:id/lock`
  (POST + DELETE) go with their last caller.

## 6. Telegram onto the client SDK

Assistant mode and code mode as agents on the SDK. `core/llm` loses its
last caller.

## 7. Delete `core/llm`; sort the rest of `core/`

Prompts and agents → user space. `PROVIDERS` / `REASONINGS` / token kinds
→ where the settings screens read them. The cli's screen tools
(`core/llm/tools/tui.ts`) and `assistantHandlers.ts` → the cli. Shared
helpers → whichever SDK owns them. Whole-file transcript routes (`PUT
/transcript`, `/sessions/:id/step`) go with the last whole-file writer.

## 8. The broken features, fixed inside the SDK's structure

- The prompt's volatile section (date, skills, secrets) is frozen at
  create. A rebuild rule: `sendMessage(text, { rebuildSystemPrompt: true })`
  carries the layout in turn-start; the server reassembles under the hold,
  answers the new sections, a record line marks it. Who triggers it
  (resume? a day boundary?) is decided then.
- The Assistant opens a new row every launch and remembers nothing: resume
  the newest assistant row.
- A model call that fails after retries drops the user's words: put them
  back to the host.
- `/compact` says "not available". Compaction is server-side on the record,
  not designed yet.

## 9. Ship

README and setup for each package, migrations in the server package, the
lockstep release script, `phantom-agent-sdk/` lifted out as its own repo,
the npm org, phantom-looper on published versions.

## Where the work stands

Done: the client SDK (one base `Agent`, the turn rule, one request per
turn start, the record appended as the turn runs, the three-section system
prompt assembled once at create); the cli on it; the server's tools defined
once and published per type; migrations 043–046. Still on `core/llm`: card
runs, cron, Telegram.

## Names — keep

`Agent`, `CodingAgent` / `AssistantAgent` / `SupervisorAgent`,
`PhantomBackend`, `ToolKit`, `SystemPrompt`, `StoredSystemPrompt`,
`SERVER_PROMPT_BLOCKS`. `resumeSession` / `create` / `newSession` /
`addToolKit` / `sendMessage` / `interrupt` / `partialMessage`.
`systemPromptLayout`, `agentText`. Server blocks: `soul_md`, `agents_md`,
`skills_list`, `secrets_list`, `time_date`, `github_token`,
`agent_database`. Errors: the server's code as sent; the SDK's own in
`SDK_ERROR_CODES`. A name says what the thing is — never "fact", "note",
"hint", "backend_error".
