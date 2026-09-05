# phantom-looper — agent orientation

A terminal coding agent with a kanban-driven supervisor loop. The PRODUCT is
the app, **phantom-cli** (an Ink TUI); **phantom-backend** is its service
and must be installed for the app to work; **core** is the code both share.
This file is the map of the whole and the rules that cross directories —
what exists on 2026-09-04, nothing planned. Each directory carries its own
map, loaded when you work there:

| map | covers |
|---|---|
| `core/CLAUDE.md` | the four agents, createAgent (retries, thinking, cache marks), the config→agent cascade, prompts (documents + wiring, `fill`, the supervisor's whole message set), openSession, the transcript format, every tool kit, the skills scanner |
| `phantom-backend/CLAUDE.md` | the HTTP surface, the session feed, sessions/folders/loops and the lock, the looper's rounds and step rule, the Telegram bot, auto-push/auto-pull, the board, the settings + secrets store, tools/containers/tasks, migrations, docker gotchas |
| `phantom-cli/CLAUDE.md` | the app: commands and keys, files, the conventions each screen and the voice pane obey |
| `phantom-cli/sidecar/CLAUDE.md` | the Python voice sidecar: pipeline, wire protocol, pins, test seam |
| `test/CLAUDE.md` | the server suites and the harness rules |
| `scripts/CLAUDE.md` | install, pairing, release, self-update, the blank-box rig; build/ host/ updater/ caddy/ |

## Names — the law

Three names exist; every identifier is one of them, or one plus a plain
suffix. Nothing else is permitted in code or docs.

- **phantom-looper** — the project: repo, npm package, on-screen wordmark
- **phantom-cli** — the app (`/phantom-cli`)
- **phantom-backend** — the service (`/phantom-backend`), also the host command

Derived and fixed: headers `x-phantom-looper-session` /
`x-phantom-looper-client` · env `PHANTOM_CLI_*` / `PHANTOM_BACKEND_*` ·
images `ghcr.io/…/phantom-backend` + `…-fs` (the agent container's root
filesystem) · dirs `~/.phantom-cli`, `/opt/phantom-looper` · Postgres schema
`phantom_looper` · compose project `phantom-looper`, workspace containers
`phantom-looper-ws-<session>`, volume `phantom-looper-workspaces` · test
Postgres `phantom-test-pg`.

## Structure — the dependency rule

```
/phantom-cli       the app. Imports /core. NEVER imports backend code — it reaches the
                   backend over the HTTP API only (phantom-cli/settings.test.ts scans for it)
/phantom-backend   the service. Imports /core.
/core              shared: llm (createAgent, agents, prompts, transcript, tool kits),
                   kanban, skills scanner, ids, session.ts (openSession). Imports from neither.
```

One package.json, one lockfile. The root tsconfig builds core + backend
(the api image runs `dist/phantom-backend/index.js`); `phantom-cli/tsconfig.json`
typechecks the app and deliberately includes `phantom-backend` so tests may
import server modules for assertions (production code may not).

```
core/              see core/CLAUDE.md
phantom-backend/   see phantom-backend/CLAUDE.md
phantom-cli/       see phantom-cli/CLAUDE.md (sidecar/ = the Python voice process)
test/              the server suites — see test/CLAUDE.md
migrations/        001–012, forward-only, applied at boot (listed in phantom-backend/CLAUDE.md)
scripts/           install / release / rig scripts — see scripts/CLAUDE.md
build/             workspace/ the fs image · testrig/ the blank Ubuntu box
host/ updater/ caddy/   the server box's one command · the update sidecar · TLS
docker-compose.yml postgres · api · docker-proxy · updater · autoheal · caddy (profile https)
Dockerfile         the api image; ships the deploy files at /host-files
.github/workflows/release.yml   v* tag → two images + four cli tarballs, draft → publish
README.md          user-facing
```

## The agents

Four, each declared in `core/llm/agents/<name>.ts` and built by
`createAgent`. Prompts are documents in `core/llm/prompts/<agent>/`,
assembled ONCE at a conversation's start and FROZEN with it — guidance that
must reach existing sessions goes in a tool's description.

- **the coding agent** — the main conversation: the cli, the looper's
  rounds, `POST /sessions/:id/turn`, Telegram code mode. Kit: the seven
  file tools + skills + web + secrets (`secret_list`/`secret_get`, this
  agent only) + `kanban_card_read`; inside a loop run also
  `kanban_card_block`, its ONE board mutation; on Telegram also
  `send_message`. It never moves cards or ticks requirements. `max_steps`
  is a setting (null = unlimited).
- **the Assistant** — the cli's side pane, and Telegram's home mode
  (server-side, same agent, headless handlers); voice is how you reach it,
  not its name. Kit: `session_*`, the full board kit, `screen_*`,
  `workspace_create_repo` (gated behind an accept/decline — the pane's rows, Telegram's buttons), the
  web kit, and the read-only workspace tools (read ls find grep) scoped to
  the session on screen / the account's active session. maxSteps 10,
  reasoning pinned `none`.
- **the Git Fixer** — auto-push's, auto-pull's and manual pull's conflict resolver,
  server-side, `bash` in the workspace container, verified against the
  repo. maxSteps 40.
- **the supervisor** — the looper's judge, in direct conversation with the
  coding agent. Read-only inspection + the card + web, plus two powers
  bound to THE card: the run-ending `kanban_card_move` and
  `kanban_card_items`. maxSteps 12.

The coding agent's `provider model base_url reasoning` is the base; each
other agent has an optional trio (`supervisor_*`, `assistant_*`,
`git_fixer_*`) resolved by core's cascade — inherit only while the provider
matches, a cross-provider override requires a model, checked at agent
BUILD.

## The looper, in one breath

Loop state = card status; rounds run on events (card writes, the two auto
switches, lock releases, boot's one sweep, chaining) — no polling, no loop
object, no retry of a failed round (it blocks the card with the reason).
`plan` is gated by `auto_plan`, `in_progress` by `auto_build`. Each card
pairs TWO sessions on one folder (the coder's and the supervisor's), named
by a loop row written once. The loop is a dialogue: the two agents' replies
cross verbatim, the loop's own messages are fixed text from
`core/llm/prompts/supervisor/`, and a status TOOL call ends the run —
`kanban_card_move` (supervisor: plan → in_progress | blocked; in_progress →
done | blocked) or `kanban_card_block` (coder). `done` is human review;
archived = complete; archiving a done card auto-pushes when
`auto_push_on_archive` is on.

## Invariants — do not break these

- **Everything the agent touches goes through the container.**
  Credential-bearing git runs in the API process behind the guard set;
  `agent_git_credentials` (off by default) opens that per workspace — env
  only, dies with the container.
- **One branch, start to finish**; restart uses the folder row's branch.
  Merge, never rebase; no push is ever forced; never `--depth` on a fetch.
- **Destroy deletes a session's FILES, not the session.** Sweep never
  discards unpushed work; explicit delete needs `?force=true`.
- **argv, never shell strings** (`Sandbox.run`); a shell exists only when
  the agent calls `bash`.
- **ONE lock in the system: the session/turn lock** (openSession,
  holder-named, TTL). Tools take no lock; git ops take no lock. Never add
  an operation mutex.
- **Git Fixer verification** = clean `status --porcelain` AND
  `--diff-filter=U` empty AND origin/<base> an ancestor of HEAD — never a
  `=======` grep.
- **Defaults live in code; the DB stores only overrides.** Null clears,
  never stored. Stocking fails open; deletion paths fail closed.
- **The coding agent may BLOCK its own card and nothing else.** Ticks mean
  VERIFIED — the supervisor's (or a person's) call. `done` is never the
  coding agent's to reach.
- **The LOOP row is the pairing, written once by the loop path.** Sessions
  carry no card and no branch (folders and loops do), so they cannot lie.
- **One session, one transcript. Everything is a session.** A new
  persistent agent conversation means a new session row.
- **Agents never run loop mechanics.** Kickoffs, briefings, copying, round
  control are loop code with fixed text; the BREAK is the eligibility
  predicate on the fresh card row, never the agent's word; a terminal
  turn's text never crosses.
- **The looper polls nothing and never retries a failed round.** Every
  loop exit is a card state a human can see.
- **The server transcript is the record**; local copies are working
  memory. The frozen prompt replays verbatim from the header.
- **The host files ride in the api image (`/host-files`)**; no script
  holds a file list; `install.sh` makes exactly one symlink. The api never
  touches the docker socket (proxy only); the updater has no network
  surface.

## Commands

```
npm test                    # pure + real-git units, no Docker
npm run test:all            # everything: containers + Postgres + the looper, models scripted at the wire
npm run test:phantom-cli    # the Ink app, headless; sidecar: (cd phantom-cli/sidecar && uv run python -m unittest test_sidecar -v)
npm run typecheck           # tsc --noEmit && tsc -p phantom-cli
npm run phantom-backend     # the server from source        npm run phantom-cli [-- --resume <id>]   # the app
npm run keys                # what your terminal actually sends for a key
```

Server changes need `docker compose up -d --build` — green tests are not the
live server. `npm test` silently ignores a listed file that does not exist.
Scripted tests use a REAL model id (`claude-fable-5`): provider behavior
keys off the id.

Never run here: Let's Encrypt issuance, the release workflow on GitHub, the
default workspace image with docker installed (heavy). install.sh is
verified on Linux through the blank-box rig.

Source patterns were ported from `../Shockwave` (pool, git guards, deploy
story, the Telegram client) and `../knack` (Sandbox, fuzzy edit, the
supervisor cycle's shape); code comments cite them.
