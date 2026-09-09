# phantom-backend/ — the service

Fastify + Postgres + Docker. Owns sessions (a checkout and a container
each), the board, the looper, the Telegram bot, auto-push and auto-pull,
and the settings store. Imports `/core`. The cli never imports this tree;
it reaches the server over HTTP only. Runs as `dist/phantom-backend/index.js`
in the api image, `npm run phantom-backend` from source.

```
index.ts          boot: env → db + migrations → paths → docker → app → listen → looper → telegram.
                  Also the maintenance loop (pool tick, session sweep, container reap) and the wiring
                  of the conflict-resolver hook + auto-push/auto-pull (git/sync.ts) into AppCtx
env.ts            the four required env vars and PORT. Everything behavioral is a setting, not env
settings.ts       DEFAULTS, DESCRIPTIONS, META, CREDENTIALS, SCOPED; resolve / resolveMany / resolveCredential /
                  settingsLayers / settingsBlock; validateSetting / validatePatch
store.ts          the settings table: (scope, namespace, key) rows; readStore, putScoped, dropKey; the secret namespace
models.ts         the model catalog from models.dev: memory → last good → snapshot file; latestModel is the model default
sessions.ts       createSession (claim a slot or clone, check out the branch), destroy, sweep, the lock
                  (acquireLock / releaseLock / renewLock / heldByOther), the loop rows, agentAfterSave, LOOP_CLIENT_ID
sessionTitle.ts   the auto-titler: shouldName, recentMessages, cleanTitle, nameSession (never throws)
systemSkills.ts   /opt/skills read out of the session image without running it; cached by image id; fails to []
environment.ts    one probe container per image id → the prompt's facts line; fails to ''
crypto.ts         AES-256-GCM, [iv 12][tag 16][ct]
docker.ts         one dockerode client over DOCKER_HOST or a known socket
log.ts            pino; logger(component); errStr(e) = message only
api/              routes, the two event buses, AppCtx — own map
looper/           the supervisor loop and the shared coding-turn runner — own map
telegram/         the bot — own map
git/              guarded git, the one sync flow (rebase), GitHub REST — own map
pool/             paths.ts (the on-disk layout) · pool.ts (warm clones, claim by rename, tick)
workspace/        container.ts (per-folder container lifecycle, buildContainerSpec) · sandbox.ts (the only dockerode exec caller)
tools/            registry.ts (the seven tool definitions) · fuzzy.ts (the edit match chain) · diff.ts · envelope.ts (ToolError)
db/               client.ts · schema.ts (drizzle mirror of migrations/; sessionColumns leaves the transcript blob out;
                  presets table for provider presets) ·
                  migrate.ts (migrations/*.sql in order, upTo bounds a replay) · workspaceSchema.ts (per-workspace cards schema, versioned)
```

## Sessions, folders, loops

Three tables carry a session. `sessions` is the conversation: status,
lock, transcript blob, title, plan_mode, `agent`, and a `folderId`.
`folders` is the checkout: branch and claim sha, permanent, named by the
owning session's id so directories keep their names. `loops` is the
looper's pairing: one row per run naming the coding session and the
supervisor session, written once. A supervisor session has no folder of
its own; its `folderId` points at the coder's, which is where its tools
read. `conversationOnly(s)` is that one special case.

`sessions.agent` says who drove the last turn. The loop stamps `coding`
at turn start; the transcript PUT re-derives it from the writer's client
id (`agentAfterSave`), so a person typing into a loop's session takes it
over and the loop takes it back next round.

## The lock

One lock in the system. Holder-named by `x-phantom-looper-client`, TTL
`session_lock_ttl_ms`, renewed by the transcript PUT, no takeover;
duplicate is the way past a holder. Tools take no lock. Auto-push,
auto-pull and the manual pull take it (client `GIT_CLIENT_ID`, renewed on
a beat) because they write the checkout and drive a coding turn to resolve
conflicts; failing to get it IS their busy test — they never inspect what
is running. Do not add an operation mutex anywhere.

## On disk

```
<root>/pool/setup/<owner>__<name>__<branch>__<ulid>   being cloned, never read
<root>/pool/ready/<same>                              claimable
<root>/work/<id>/repo                                 the checkout; the container mounts work/<id> at /workspace
<root>/work/<id>/{scratch,logs,web}                   beside repo/, so a commit-everything never commits them
```

A claim is a rename, so it is atomic and needs no lock. All three trees
must share one filesystem. `pool.tick()` is single-flight, fails open on
an unreadable workspace list, and never deletes on doubt.

## Settings

Defaults live in code; the DB stores only overrides. Resolution is
default → global → workspace → session, most specific wins, one read.
Null in a PATCH clears and is never stored; a nullable key must default
to null (checked at module load). Adding a key means DEFAULTS +
DESCRIPTIONS + META, and SCOPED if it may be overridden below global.
Credentials are keys of the same store, encrypted, declared in
CREDENTIALS. `github_token` is the one credential a workspace may hold.
Secrets (the coding agent's tokens) are the `secret` namespace, walled
off by the namespace filter on every general read.

## Containers and the tool path

Everything the agent touches goes through its container. `Sandbox.run`
takes argv, never a shell string; a shell exists only when the agent
calls `bash`. Reads are `cat`, writes are `cat > "$1"` over stdin. The
container is stateless and belongs to the folder; it starts on the first
tool call, dies after `container_idle_ms`, and is recreated on demand.
Docker cannot kill an exec, so bash runs under a wrapper that writes its
session id to a pidfile, and esc or a timeout kills the whole tree with
`pkill -s` through a second exec. `container_docker` makes the container
privileged with its own graph volume so the agent can run a nested
dockerd; the daemon starts only when the agent runs `start-docker`.

Credential-bearing git runs in this process with the guard set in
`git/git.ts`. `agent_git_credentials` is the one deliberate exception:
the token goes into the container env, per workspace, and dies with it.

Server changes need `docker compose up -d --build`; green typecheck is not
the live server.
