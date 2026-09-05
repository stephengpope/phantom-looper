# test/ — the server suites

Real git, real Postgres, real Docker containers. Nothing is mocked; the fakes
are boundary servers a test seam points at — a tiny "GitHub" in
`phase4.test.ts` (`GITHUB_API_BASE`), a tiny "Firecrawl" in `web.test.ts`
(`FIRECRAWL_API_BASE`) — and the MODEL scripted at the wire through
createAgent's `fetch` seam (`ctx.modelFetch`; Anthropic JSON + SSE shapes;
every route in between is real). `looper.test.ts` and
`e2e-auto-push.test.ts` each carry their own copy of the scripted wire;
`phase4.test.ts` drives the Git Fixer through the typed `GitFixerDriver`
seam instead.

```
npm test            # unit · llm · skills · deploy · session · looper-logic · telegram — ~1s, no Docker, no Postgres
npm run test:all    # test/*.test.ts serially, ~2 min; needs a running Docker daemon
npm run test:down   # docker rm -f phantom-test-pg (the shared Postgres is otherwise left running)
```

`tsx --test`, untyped — `npm run typecheck` does not cover this directory.
`--test-timeout=60000` so a hung test fails; `--test-concurrency=1` only on
`test:all` (the Docker suites share one Postgres and one daemon; `npm test`
runs its files concurrently). Node's runner SILENTLY IGNORES a listed file
that does not exist — a deleted suite would not move the green signal, so
adding a suite means adding it to the `test` script in package.json.

**The scripted wire answers BOTH shapes, tool calls included.** Every
server-side turn streams (both looper seats, the turn route), so a scripted
step with a `tool` must ride the SSE branch as a `tool_use` content block —
on the JSON branch alone a scripted supervisor move silently never happens.
Session-title calls (fired by every transcript save, fire-and-forget) are
answered out of band and kept out of `wire`, or one lands as "the last
coding request".

**The scripted wire's seat discriminator is structural, never wording:**
the supervisor's request is the one carrying the `kanban_card_move` tool.
Match loop messages on the templates' frozen first lines (`firstLine.*`
from `core/llm/prompts/supervisor/wiring.ts`), never on prose — a reworded
prompt must not break a test. `llm.test.ts` pins that every loop message
starts with its marker.

| file | covers |
|---|---|
| `harness.ts` | `ensurePostgres`, `testDb(name)`, `ensureWorkspaceImage`, `FS_IMAGE`, `testRoot`, `git`, `setWorkspaceSetting` |
| `unit.test.ts` | URL policy (`remoteUrl`, `hasEmbeddedCredentials`, `parseGitHubUrl`, `parseRepoRef`), crypto, ULIDs, `classifyGitFailure`, `cloneFresh` depth, ancestry after fetch, `localState`, pool claim race + cross-workspace slots, boot cleanup, slot age, the titler's pure rules (`shouldName`, `cleanTitle`, `recentMessages`), `composeFacts` (probe → prompt line), the tasks helpers (`parsePs` procps/busybox, `liveGroups`, `elapsedSeconds`) |
| `llm.test.ts` | `core/llm` without a network: createAgent on a capturing fetch, the prompt stack (skills + secrets indexes), every kit (workspace pick, sessions handler, coding card-read vs the Assistant's full board, web/skills/secrets/fixer-bash, the abort signal into tool fetches), API key vs subscription token, the thinking rule, provider routing, the model cascade, the transcript format (usage lines, event round-trip), the Git Fixer's per-attempt transcripts |
| `skills.test.ts` | pure `core/skills` on a temp dir: one-level scan, folder-name identity, frontmatter edge cases, merge order, name rule, SKILL.md validation, path containment, lint |
| `deploy.test.ts` | host-artifact rules: `/host-files` delivers every deploy file, no file lists in scripts, one symlink, exec bits, the release-tag regex agreed in three places, trigger dir agreement |
| `session.test.ts` | core `openSession` with a scripted ApiCall: create/attach/restart, the lock contract both ways, frozen-header-wins, `pickKit` presets |
| `looper-logic.test.ts` | the pure rules: `canTurn` (per-column switches, tri-state over default, trigger AND break), `unsentKickoff`/`wasSent` (matched on the frozen first line), `needsFreshSession` (revision clock), `replies` (terminal turns are silence), `nextStep` (briefings, copy owed / delivery owed / return, ordered matching), the card-bound tools (per-column enum, vital descriptions) |
| `telegram.test.ts` | the bot's pure pieces, no db/docker/network: markdown → Telegram entities (`toTelegram`, `splitFormatted`, `clampEntities` — UTF-16 offsets pinned against a code-point refactor), the attachment policy (`classify`, `sniffImageMime`, `writeAttachment`, `composeMessage`), file delivery (`extractMedia` — offsets hold past an emoji, `extractBarePaths`, code spans shown not sent, `deliveryKind`, `collectDeliverables` confined to the session dir), the approval gate (`Approvals` on a fake client: buttons, tap/word/abort answers, stale tap, one ask per chat) |
| `integration.test.ts` | auth, the flat settings store (override/delete/validate/meta, encrypted credentials, the workspace layer), workspaces + credential chain, 20 concurrent creates, branch-per-session, restart-by-id, pool tick, destroy ± force, `GET /sessions` + launcher shape, `POST /update` |
| `phase2.test.ts` | `GET /tools`, every tool through a real container, fuzzy edit, images, grep/find, bash, container recreate, image pull on first use, the two kill paths (client abort kills the tree; exec timeout kills the process), the /skills ROUTES |
| `dind.test.ts` | docker-in-the-workspace (`container_docker`): a privileged container from an alpine+docker image, created through `ContainerManager`, is really privileged with an anonymous `/var/lib/docker` volume; `start-docker` brings the nested dockerd up (not before — the daemon is never auto-started), the agent reaches it without sudo, and the graph driver is overlay2. Skips itself where a privileged nested dockerd cannot build/run |
| `phase3.test.ts` | bash timeout/exit, push only the session branch, pull + conflict semantics, lock vs running command, detached bash ND-JSON, tail + spill, no background git, delete pushes first, the `/tasks` routes (tracked rows, kill by sid, stale-row closing, listing never starts a container) |
| `phase4.test.ts` | the Git Fixer's loop, `verifyResolved`, `POST /workspaces create=true` and `GET /github/repos` (paged, `added` marks, 404 without a token) against the fake GitHub (real paths), and AUTO-PUSH on real git: clean push, push-twice-no-self-conflict, conflict through the fixer, fixer failure leaves the branch, base-moved retry, nothing-to-push, commit-message fallback |
| `kanban.test.ts` | the card routes: columns + prefix (`card_prefix` editable, null reverts), CRUD/archive, the archive listing (`archived=only` keyset-paged, `seq` lookup), requirement keys, item ops by key, the auto switches, `pinned`, hard delete, revisions by trigger, auto-push-on-archive (loop session pushes, no loop = archive only, failure un-archives into blocked), the board GET's `card_sessions` |
| `e2e-auto-push.test.ts` | the WHOLE journey: an auto-run card walks plan → in_progress → done with the coder REALLY writing the file (real container + checkout), the supervisor ending each phase by its move tool, a human archives, `auto_push_on_archive` carries it onto origin/main — model-written message, session trailer, branch backup, fast-forward, card stays archived |
| `looper.test.ts` | the looper END TO END, tool_use included: the dialogue plan → in_progress → done (kickoff, briefings + copied replies, verbatim delivery, terminal silence, block tool on every coder turn); the coder blocks and the return message carries the answer back; a FAILED round blocks and never refires; one poke chains both phases; the switches gate their columns; the budget seeds once and blocks on breach; a card PATCHed into plan runs through the route trigger; `POST /sessions/:id/turn` streams, saves, respects the lock; the SESSION FEED (`GET /sessions/:id/events`) carries turn-start, every part, turn-end and the `transcript` record for the watched session only, and a turn with nobody watching still saves the whole record; the RELAY (`POST /sessions/:id/events`): a lock holder's records reach a watcher verbatim and in order, capped, the publisher never hears itself, a non-holder gets 409; the HOLD on the feed (first record on connect, take / renew / release as they happen, never to the holder itself); turn-start moves the list preview and names a first message at once, never a loop seat's kickoff |
| `web.test.ts` | `/web` over the fake Firecrawl: keys, search mapping + filters, fetch under `work/<id>/web/`, error passthrough, one proxy retry |
| `secrets.test.ts` | the `secret` namespace + `/secrets` (Postgres, no Docker): the namespace WALL (`github_token` as a secret never shadows the credential), one row per secret, PUT validation, tags + cascade, layer-scoped delete, migration 010 over a populated table (`upTo: '009_plan_mode.sql'`) |
| `transcripts.test.ts` | transcripts + the lock: round-trip, one holder (409; client header required), expiry + renewal-by-save, duplicate past a holder, purge, unpushed refusal, token usage on demand + cached by stamp, rename rules, plan mode on the row, list pages by cursor (id tiebreak), the list's server-side filters (`typed`, `supervisor`) and a `total` that counts exactly the filtered rows, the 200-char preview cap |

## Harness rules — do not regress these

- **One Postgres container for the whole run** (`phantom-test-pg`, port
  55432, tmpfs data dir, `fsync=off`, `synchronous_commit=off`), started if
  absent and **left running**. Each suite's `testDb(name)` gets database
  `t_<name>_<Date.now() base36>` inside it.
- **One workspace image** (`phantom-test-fs`: alpine 3.20 + ripgrep + git),
  built once by `ensureWorkspaceImage()`.
- **Bind-mount roots come from `testRoot()` — `/tmp`, no platform branch.**
  On macOS `/tmp` IS `/private/tmp`, one of Docker Desktop's default shared
  directories; on Linux it is the tmp dir. `testRoot()` is the ONLY place a
  temp path is written by hand. Every other temp path is `os.tmpdir()` — a
  hardcoded `/private/tmp` does not exist on Linux.
- **Origins are local bare repos over `file://`** (`harness.git()` sets
  `protocol.file.allow=always`); the guarded git path runs for real, no PAT.
- **`migrate(pool, { upTo })`** tests a pre-migration state.
- **`setWorkspaceSetting(db, workspaceId, key, value)`** writes a
  workspace-layer settings row — overrides are scoped rows, not columns.
- Ownership/uid assertions pass on macOS because VirtioFS squashes uids;
  they only mean something on Linux.
- **Scripted models use a REAL model id** (`claude-fable-5`): the thinking
  rule keys off the id and a made-up id exercises a path no live model
  takes.
- The e2e wire answers session-title calls out of band (keyed on the
  titler `SYSTEM`'s first words, `core/llm/prompts/helpers/`) so the
  titler, fired by every transcript save, never eats a scripted step.
