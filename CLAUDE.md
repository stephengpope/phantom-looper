# phantom-looper — agent orientation

A terminal coding agent with a kanban-driven supervisor loop. The product
is **phantom-cli** (an Ink app); **phantom-backend** is its service and
must be running for the app to work; **core** is what both share. This
file is the index and the rules that cross directories. Each directory
carries its own map, loaded when you work there.

| map | covers |
|---|---|
| `core/CLAUDE.md` | openSession, ids, checklist keys, the skills scanner |
| `core/llm/CLAUDE.md` | createAgent, the config cascade, the transcript format, the four agent builders |
| `core/llm/prompts/CLAUDE.md` | the prompt documents, `fill`, the looper's message set |
| `core/llm/tools/CLAUDE.md` | every tool kit and which agent carries which |
| `phantom-backend/CLAUDE.md` | boot, sessions/folders/loops, the lock, settings, containers, the on-disk layout |
| `phantom-backend/api/CLAUDE.md` | every route, the two event feeds, the cards |
| `phantom-backend/looper/CLAUDE.md` | the supervisor loop and the shared coding-turn runner |
| `phantom-backend/telegram/CLAUDE.md` | the bot |
| `phantom-backend/git/CLAUDE.md` | guarded git, auto-push's rebase, auto-pull, conflict resolution |
| `phantom-cli/CLAUDE.md` | the app: sessions in a window, the watch and feed, the Assistant, drawing |
| `phantom-cli/components/CLAUDE.md` | the screens and the pieces they share |
| `phantom-cli/sidecar/CLAUDE.md` | the Python voice process and its wire |
| `test/CLAUDE.md` | the server suites and the harness |
| `scripts/CLAUDE.md` | install, release, the rig, the deploy files |

## Names

Three names exist. Every identifier is one of them or one plus a plain
suffix.

- **phantom-looper**: the project, the npm package, the wordmark
- **phantom-cli**: the app, `/phantom-cli`
- **phantom-backend**: the service, `/phantom-backend`, and the host command

Derived: headers `x-phantom-looper-session` and `x-phantom-looper-client`;
env `PHANTOM_CLI_*` and `PHANTOM_BACKEND_*`; images
`ghcr.io/…/phantom-backend-api` and `…-session`; dirs `~/.phantom-cli` and
`/opt/phantom-looper`; Postgres schema `phantom_looper`; compose project
`phantom-backend`; containers `phantom-looper-ws-<session>`; volume
`phantom-looper-workspaces`; test Postgres `phantom-test-pg`.

## Structure

```
/phantom-cli       imports /core. Never imports backend code; it reaches the backend over HTTP
/phantom-backend   imports /core
/core              imports from neither
migrations/        001–012, forward-only, applied at boot
```

One package.json, one lockfile. The root tsconfig builds core and backend;
`phantom-cli/tsconfig.json` typechecks the app and includes the backend so
tests may import server modules.

## Commands

```
npm test                    # pure + real-git units, no Docker
npm run test:all            # everything: containers, Postgres, the looper with the model scripted at the wire
npm run test:phantom-cli    # the app, headless
npm run typecheck           # tsc --noEmit && tsc -p phantom-cli
npm run phantom-backend     # the server from source
npm run phantom-cli         # the app; -- --resume <id>
npm run keys                # what your terminal sends for a key
```

Server changes need `docker compose up -d --build`. Green tests are not
the live server.

## Invariants that cross directories

- Everything the agent touches goes through its container. Credential
  git runs in the api process behind the guard set. `agent_git_credentials`
  is the one exception, off by default, env only.
- One branch per session, start to finish. ONE sync flow (`git/sync.ts`):
  squash to one commit, replay onto base, fast-forward. Auto-pull is that flow
  without the last step; the manual pull is the same. The branch is backed up
  before any rewrite, then force-pushed with a lease. Never `--depth` on a
  fetch.
- One lock in the system: the session/turn lock. Tools and git take none.
  Never add an operation mutex.
- Everything is a session, one session one transcript. The server
  transcript is the record; local copies are working memory.
- Defaults live in code; the DB stores only overrides. Null clears and is
  never stored. Stocking fails open; deletion fails closed.
- Conflicts are resolved by the coding agent that wrote the code, as a turn in
  its own conversation. There is no separate fixer.
- Loop state is card status. The looper polls nothing and never retries a
  failed round. Every loop exit is a card state a person can see. Agents
  never run loop mechanics. The coding agent may block its own card and
  nothing else; ticks mean verified.
- A prompt is frozen with its conversation. Guidance that must reach a
  running session goes in a tool's description.
- The host files ride in the api image; no script holds a file list. The
  api never touches the docker socket directly.

Source patterns were ported from `../Shockwave` and `../knack`; code
comments cite them where it matters.
