# phantom-backend/ — the service

Fastify API + Postgres + Docker: owns sessions (a git checkout and a
container each), the kanban board, the looper, the Telegram bot, auto-push/auto-pull,
and the ONE flat settings store. Imports `/core`; never imported by
`/phantom-cli`. Runs from `dist/phantom-backend/index.js` in the api image
(`npm run phantom-backend` from source).

```
index.ts            boot: env → db + migrations → paths → docker → app → listen → looper.start() → telegram → shutdown hooks
env.ts              REQUIRED: ENCRYPTION_KEY (base64, exactly 32 bytes — checked at boot), DATABASE_URL,
                    WORKSPACE_ROOT_PATH, API_KEY; PORT defaults 8080. Read elsewhere: DOCKER_HOST (docker.ts),
                    WORKSPACE_VOLUME (compose: dockerd resolves mounts host-side), UPDATE_TRIGGER_DIR (system.ts),
                    LOG_LEVEL, APP_VERSION, PHANTOM_BACKEND_ADDRESS (index.ts → the Telegram webhook host);
                    test seams GITHUB_API_BASE, FIRECRAWL_API_BASE
settings.ts         DEFAULTS / DESCRIPTIONS / META / CREDENTIALS / SCOPED — every general key, declared in code
store.ts            the settings table: read/put/drop by (scope, namespace, key); computeLayers
crypto.ts           AES-256-GCM, layout [iv 12][tag 16][ct] — credentials and secrets at rest
sessions.ts         create / restart / destroy / sweep, the session lock, loop + agent stamps
sessionTitle.ts     the auto-titler (never throws, no setting)
systemSkills.ts     /opt/skills out of the fs image via a created-never-started container's archive; cached by image ID; fail-open []
environment.ts      probes the fs image ONCE (os-release/uname/node/python, no network, 30s) → one prompt line; cached by image ID; '' on failure
docker.ts           dockerode over DOCKER_HOST or a known socket — the ONE docker client
log.ts              pino root at LOG_LEVEL; `const log = logger('<component>')`; errors as {err: errStr(e)} — message only, never a stack
api/app.ts          envelope helpers, bearer hook, error/404 handlers, route registration, AppCtx (ctx.looper set after listen)
api/routes/         settings secrets workspaces sessions(+lock, transcript, turn, events, duplicate, token-usage) fs(tools) tasks skills git kanban web system
looper/             engine.ts (events → runLoop → runTurn) · logic.ts (pure rules) · turn.ts (the shared coding-turn runner) · injectFetch.ts
telegram/           the bot as a client of this server (below): engine.ts (reconcile + webhook + the two modes) · commands.ts · assistant.ts
                    (server-side Assistant turn) · sink.ts (streaming bubble + file delivery) · client.ts · entities.ts · bubble.ts · deepgram.ts ·
                    connect.ts (the outbound connection policy, shared with the cli sidecar) · attachments.ts · sendMessageTool.ts (`send_message`) ·
                    mediaTags.ts (paths named in a reply) · approvals.ts (the approval gate) · store.ts (the migration-012 rows)
git/                git.ts (guarded exec, classifyGitFailure, primitives) · engine.ts (manual push/pull/status) · autoPush.ts · autoPull.ts ·
                    gitFixer.ts (+verifyResolved) · commitMessage.ts · github.ts (REST on GitHub's real paths) · remote.ts (pure URL policy)
pool/               pool.ts (warm clones: claim by rename) · paths.ts
workspace/          container.ts (per-session container lifecycle; buildContainerSpec is its pure createContainer spec) · sandbox.ts (the ONLY container-SDK caller)
tools/              registry.ts (the seven tool definitions) · fuzzy.ts · diff.ts · envelope.ts
db/                 client.ts · schema.ts (drizzle mirror; `sessionColumns` excludes the transcript blob) · migrate.ts · workspaceSchema.ts
```

## HTTP surface

Auth: `authorization: Bearer $API_KEY` on everything. Session-scoped routes
take `x-phantom-looper-session`; the lock identity rides
`x-phantom-looper-client`. Every body is `{ok:true,data}` /
`{ok:false,error:{code,message,retryable}}`. Fastify 400s a JSON POST with an
empty body — always send `{}`; inversely `injectFetch` must DROP
content-type when there is no body.

| area | routes |
|---|---|
| settings | `GET/PATCH /settings` (`?workspace=`/`?session=` picks the layer), `DELETE /settings/:key` |
| secrets | `GET /secrets` (names + descriptions, never values; `?workspace=` = global + that layer merged, the agent's view; bare = every layer, rows tagged, the cli's), `PUT/GET/DELETE /secrets/:name` (PUT/DELETE address one layer via `?workspace=`; GET cascades workspace → global) |
| workspaces | `GET/POST /workspaces` (`create=true` makes a PRIVATE GitHub repo + seed push), `GET/PATCH/DELETE /workspaces/:id` (`?confirm=true` drops the schema; the GET carries every setting's layers and `cardPrefix`); `GET /github/whoami`; `GET /github/repos` (every repo the global token can see — owner/collaborator/org, newest push first, paged at 100 up to 10 pages — each with `added`: a workspace already points at it; 404 `not_set` without a token) |
| sessions | `GET/POST /sessions` (`{workspace_id, id?}` — id restarts; the POST response carries `skills`, `secrets`, `environment`, `agent_git_credentials` — the four frozen prompt inputs; the GET answers `{sessions, total}` — `typed=true` keeps only sessions something was typed into, `supervisor=false` leaves out the looper's supervisor seats, `git=true` adds `work` per row (not_pushed / not_merged / merged, read from the checkout), and `total` counts exactly the filters in force; each row carries `locked`, `lastUserMessage` (capped at 200 chars; moves at every turn's START and at the save — a preview, not the record), `agent`, `name`/`turn_count`/`name_manual`, `plan_mode`, `branch` from the folder row; pages via `?limit&before&before_id` — keyset on `last_used_at desc, id desc`, a short page = the end, no params = everything), `GET/PATCH/DELETE /sessions/:id` (`?force`/`?purge`; PATCH `{idle_destroy_ms?, name?, plan_mode?}`), `POST /sessions/:id/duplicate` (copies plan_mode always; name/name_manual/lastUserMessage only when the source has a transcript) |
| transcript + lock | `GET/PUT /sessions/:id/transcript`, `GET /sessions/:id/token-usage`, `POST/DELETE /sessions/:id/lock` |
| turn | `POST /sessions/:id/turn {message, plan?}` — one coding turn, ND-JSON stream, `plan` = readonly kit; no block tool on manual turns. Its reply is a VIEW of the session feed: it subscribes and maps `part` records to its own `{type:text|tool}` lines, so parts are published in exactly one place |
| session events | `GET /sessions/:id/events` — the session's live feed (api/sessionEvents.ts): ND-JSON, `{turn-start,agent,message}`, `{part}` per AI SDK stream part (tool results capped at 16KB and marked `capped`), `{turn-end}`, `{error}`, `{transcript,updated_at,by}` when the record is saved by ANY client, `{lock,locked,by,label,agent,expires_at}` FIRST on connect and on every take / renew / release, `{heartbeat}` every 15 s. Every turn streams here whoever runs it. A reader never gets its OWN events back. Reads are free while another client holds the session. No replay. `POST /sessions/:id/events {events:[…]}` — the relay: a cli window publishes the turn IT runs (the same records, in order); only the lock holder may (409 `session_not_held` / `session_locked`); parts capped; nothing stored |
| tools | `GET /tools` (`{name, summary, description, input, mutates, streaming}`), `POST /tools/{bash,read,write,edit,ls,find,grep}` |
| tasks | `GET /sessions/:id/tasks`, `DELETE /sessions/:id/tasks/:sid` |
| skills | `GET /skills`, `GET /skills/:name` (`?file=`), `POST /skills` (repo tier only) |
| git | `POST /git/push`, `POST /git/pull`, `GET /git/status`, `POST /git/auto-push`, `POST /git/auto-pull` (both ND-JSON streams through one `streamRun`: `step` records, `heartbeat`, one `result`) |
| commands | `GET /commands/:cmdId/logs` — detached bash ND-JSON replay + follow |
| cards | `GET/POST /workspaces/:id/cards` (the GET's modes: default = the board, unarchived; `?seq=` = that one card, archived or not; `?archived=only` = the archive, newest `updated_at` first, keyset-paged `limit/before/before_id`, `total` = the whole archive; `?archived=true` = everything), `PATCH/DELETE /workspaces/:id/cards/:cardId`, `GET /workspaces/:id/revisions?card=<seq>`, `GET /workspaces/:id/events` (the board's live feed — ND-JSON, open until the client hangs up) |
| web | `POST /web/search`, `POST /web/fetch` (session header) |
| system | `GET /health` (token required; version), `POST /update {tag}` |
| telegram | `POST /telegram/webhook` — the ONE unauthenticated route; its secret-token header, timing-safe-checked, is the auth |

## Sessions, folders, loops, the lock

- **Sessions are conversations; folders are checkouts; loops are the
  pairing** (migration 003). A folder takes the id of the session that
  owns it (dirs, containers, git paths keep their names); branch and claim
  live on the folder row; a loop row is `(workspace, card, coding_session,
  supervisor_session)`, written ONCE when a card enters the loop. Sessions
  carry no card and no branch — they cannot lie. `sessions.agent`
  ('coding'/'supervisor'/null) is WHO DROVE THE LAST TURN: the loop stamps
  its coder seat at every turn start (`stampAgent`), and every transcript
  PUT re-derives it from the writer's client id (`agentAfterSave`:
  `LOOP_CLIENT_ID` → 'coding', anyone else → null; a supervisor record
  never changes hands). So a person typing into a card's coding session
  takes it over — /resume reads `manual` — and the loop takes it back when
  the card comes round again. Never a client's claim.
- **One branch, start to finish**: the folder's own `{prefix}/{id}`, cut
  from base; restart by id re-clones and checks the same branch out. Destroy
  deletes FILES, not the session. Never `--depth` on a fetch; a session
  branch adds its fetch refspec at creation.
- Layout on disk: pool `setup/` → `ready/` → `work/<id>/repo` (claim is a
  bare `rename` — atomic, no lock, loser gets ENOENT; all three trees share
  one filesystem). The container mounts `work/<id>` at `/workspace`, repo at
  `/workspace/repo`; `logs/` (detached bash + spill) and `web/` (fetched
  pages) sit beside `repo/`, outside it, or auto-push's commit-everything
  step commits them.
- `pool.tick()` (single-flight): reaps setup corpses > 30 min, drops slots of
  unknown workspaces, evicts past `spare_clone_max_age_ms`, refreshes past
  `spare_clone_refresh_ms`, restocks to `spare_clones`; an unreadable
  workspace list ABORTS the tick (fails open, never deletes on doubt).
- **Every turn streams on the session bus, whoever runs it**
  (`api/sessionEvents.ts`, one emitter per process). A turn the SERVER runs
  (the looper's rounds, the turn route, Telegram) publishes every part
  in-process; a turn a CLI WINDOW runs is relayed by that window through
  `POST /sessions/:id/events` — same records, same order; a watcher cannot
  tell the two apart, and the record saved is the same (createAgent's
  `record` seam). Every event carries its publisher's client id and the
  feed route drops a subscriber's own events — the ONE echo rule, on the
  server. Only the lock holder may publish. The turn-end signal a client
  acts on is the `transcript` event, published by the transcript PUT — the
  one place that knows the record landed. Both looper seats read their
  stream through `turn.ts drain`: a failure inside a stream is an `error`
  PART, so drain throws the part's error — the model's own words are what
  block the card. The api is built with `forceCloseConnections: true`: a
  shutdown never waits on feeds held open by watchers. The HOLD rides the
  same feed: every lock write (`POST/DELETE /sessions/:id/lock`, the PUT's
  renew) publishes a `lock` record, and a feed opens with one, so a
  watcher's spinner is live and carries `expires_at` to lapse on its own.
- **The transcript IS the record and lives ON the sessions row** (migration
  005). Every sessions read selects `sessionColumns`, never the bare table —
  the blob reaches only the transcript routes.
- **ONE lock in the system: the session/turn lock.** Holder-named
  (`x-phantom-looper-client`), TTL `session_lock_ttl_ms`, renewed by the
  transcript PUT, no takeover — duplicate is the way past a holder. `label`
  is display only and may differ per lock; the identity is the client id
  alone. Tools take no lock; git ops take no lock (a true simultaneous git
  op errors on git's own index.lock). Never bring an operation lock back.
- **Token usage**: summed from the transcript's usage lines ONLY when
  `GET /sessions/:id/token-usage` asks, cached in `tokens_*` while
  `tokens_as_of = transcript_updated_at`. Nothing runs at save time.
- **Titles** (`sessionTitle.ts`, migrations 007/008), fire-and-forget off
  the session routes. A session's FIRST message names it the moment its
  turn STARTS: the `turn-start` record on the session bus calls
  `sessions.ts turnStarted`, which moves `last_user_message` and says
  whether this is the first message (unnamed, no turn saved, no loop seat —
  a seat's first message is the fixed kickoff). The transcript PUT bumps
  `turn_count` in the same UPDATE as the blob, then fires the titler when
  `name_manual` is false and `shouldName` says so (turn 1 while still
  unnamed, then every 10th). Input = last 20 messages (`recentMessages`:
  tool traffic clipped, usage lines skipped); model = the Assistant's trio
  cascading to the coding agent's; 3 tries; `cleanTitle` caps 80 chars;
  every failure leaves the old name. The UPDATE is conditioned on
  `name_manual = false`, so a `/rename` beats a title in flight; PATCH
  `name: null` clears both marks.
- `plan_mode` (migration 009) is the row fact clients read to build the
  readonly kit; the looper never reads it (plan mode there = card in
  `plan`).

## The looper (looper/)

**No loop object, NO polling. Loop state = card status; turns run on
EVENTS.** `ctx.looper = {runLoop(workspaceId, seq), runLoopOfSession(id,
releasedBy), runAllLoops(workspaceId?)}` — fire-and-forget, `?.`-guarded at
every call site. Triggers: every card POST/PATCH calls `runLoop` on that
card; an `auto_plan`/`auto_build` write calls `runAllLoops` on its
workspace (global: all); boot runs `runAllLoops` once; a released session
lock calls `runLoopOfSession` (ignoring the engine's own releases); a turn
that ran CHAINS into the next. Calls on one card coalesce
(`running`/`pending` — never two turns on a card; cards run concurrently).

**canTurn** (`logic.ts`): not archived AND the switch for ITS column on —
`plan` by `auto_plan`, `in_progress` by `auto_build`; the card's tri-state,
else the workspace setting. `runLoop` re-reads the card from fresh rows
before every turn; the BREAK is `canTurn` no longer matching. `runTurn` does
one turn; `TurnOutcome` = `turn` | `moved` | `idle` | `skipped` (a seat
locked elsewhere — its release re-runs the loop).

**A turn that throws blocks the card** with `looper turn failed: <why>`
as `blocked_reason`. Blocked is not a loop column, so the loop is over;
nothing refires. Model calls retry on core's schedule (~2.7 min, under the
lock TTL by design), each attempt logged via `onRetry`. A crash loses
nothing: the card, its two sessions and their transcripts are the state;
the boot pass resumes.

**The loop is a DIALOGUE.** The supervisor and the coding agent talk
directly: the loop copies each reply's TEXT into the other's conversation
verbatim (tool traffic never crosses), and a status TOOL call ends the run.
One turn = the ONE owed step, then chain:

1. **Seat the sessions** — two per card, named by the loop row. Entering
   `plan` starts a NEW loop (coder, supervisor, loop row born together);
   `needsFreshSession` reads the card's revision history — no status
   revision on record = born in `plan`, keep the loop. Both open through
   core `openSession` as client `supervisor` with `lock: true`; either held
   elsewhere → `skipped`. The lock's **label** is not the client id: `heldBy`
   (logic.ts) gives the ONE WORD a locked-out window draws beside a spinner —
   `planning` / `building` off the card's column on a coding session,
   `reviewing` on the supervisor's record. The supervisor's read-only tools
   bind to the CODING session's id (where the files are);
   `loopSupervisorTools` is rebuilt each turn for the current column.
2. **The STEP RULE** (`logic.ts`): `unsentKickoff` first — a kickoff is owed
   when the coding conversation lacks its frozen first line (`plan` + empty
   → `PLAN_CARD` in plan mode; `in_progress` after `PLAN_CARD` → `BUILD_FROM_PLAN`,
   same session; `in_progress` with no history → `BUILD_FROM_CARD`); the
   kickoff is one coding turn. Otherwise `nextStep`: an uncopied coder turn
   → run the SUPERVISOR with any unsent briefing first
   (`IMPLANTED_REVIEWING_PLAN` / `_WORK`, one per phase the coder has
   entered, USER role) then the replies; an undelivered supervisor turn → one
   coding turn with it; neither → the card came back from blocked/done → one
   coding turn with `CARD_IS_BACK` (the human's `resolution` rides along and
   is cleared with `blocked_reason` on delivery). Copies are verbatim, so
   an ordered text match IS the state — same rule on turn 1, turn 50, and
   after a restart. Deliver/return turns run in plan mode while the card is
   in `plan`. The coder's block tool rides OUTSIDE the readonly preset by
   design.
3. **A status tool ends the run.** `kanban_card_move` (supervisor: the
   column's exits only) and `kanban_card_block` (the coding agent's ONE
   board mutation, every loop turn, plan mode included). A turn that called
   one is TERMINAL (`ENDING_TOOLS` read off the transcript): its text never
   crosses; the tool's own PATCH is the event; the break is canTurn on
   the fresh row, never the agent's word. Requirement ticks are the
   supervisor's own verification via `kanban_card_items`, by key. **Token
   budget** (`loop_budget_tokens`, null = off): seeded once per chain from
   both seats' token-usage, each turn's numbers added, checked before every
   turn; breach blocks the card with the spend. `done` is where human
   review happens; **archived = complete**.

The engine, `POST /sessions/:id/turn` and Telegram code mode share
`turn.ts runCodingTurn` (kits, cache marks, `memoryRecorder`, token sum,
`extraTools`) and reach the server through `injectFetch` — headless clients
of this server's own surface, same openSession, kits, locks, envelope and
record as the cli. All loop-authored text is in
`core/llm/prompts/supervisor/`; agents never run loop mechanics.

## Telegram (telegram/)

The bot is another headless client of this server, started after listen
like the looper (`ctx.telegram`, `TelegramEngine`). ONE authorized user,
DM-only, WEBHOOK (never polling). Its migration-012 rows are STATE, not
settings: the account (one row, mode + active session + webhook secret
encrypted), `telegram_sent` (every bubble → its origin, so a reply switches
into its conversation), update dedup. Settings are ordinary declared keys
(`telegram_enabled/_authorized_user/_reply_mode/_transcript_echo`) + the
`telegram_bot_token` credential.

**Two independent knobs on the account row** — WHICH session
(`activeSessionId`, `store.setActiveSession`) and WHO answers (`mode`,
`store.setMode`); never written together. The engine's `switchSession` and
`enterMode` are the only transitions (the 🔀 line, the mode line and the
menu swap live there). Pointer movers: `/sessions n`, `/new`, the
Assistant's `session_switch` — the mode stays, so the Assistant keeps the
conversation. Mode doors: `/code [n]` (the ONE slash command into a coding
agent; `n` points first), `/assistant` home, and a reply to a bubble (a
coder's bubble → its session in code mode; an Assistant bubble → home).
ASSISTANT (home, default) — a plain message is an Assistant turn
(`assistant.ts`: the SAME core `assistantAgent`, headless handlers over the
card/session routes, ONE in-memory conversation reset on restart; file tools
+ web bind read-only to the active session; `git_auto_pull` over core
`autoPullSession` — the active session or an id). CODE — a plain message is a
real `runCodingTurn` on the active session, lock per turn, `send_message` (a
deliberate DM outside the streamed reply; delivery mode from
`telegram_reply_mode`) injected via `extraTools`. The command menu
(`setMyCommands`) is per mode — the global default is home's, the
authorized chat's is swapped by `enterMode` (chat scope; Telegram pushes a
private-chat change at once) and re-set at `reconcile` — and is a HINT:
every handler answers in either mode. A busy turn queues the next message
into one follow-up (the cli's queue shape); `/stop` drops the queue and
aborts.

**The approval gate (`approvals.ts`).** The cli's gate, server-side: a gated
tool (`workspace_create_repo`, the Assistant's) calls `Approvals.request` and
waits; the user gets ONE bubble — kind, the exact subject, `[✅ Accept]
[✖️ Decline]` inline buttons — and answers by tapping (a `callback_query`
update, routed in `handleUpdate`; every tap is `answerCallbackQuery`'d) or by
saying the exact word as text or voice (`handleText`, exact match like the
wake word). Rules: ONE ask per chat (a second resolves false at once); the
tool's abort (`/stop`) declines; ANY other message declines and is not
consumed — it queues as the follow-up, so "no, call it foo" reaches the
Assistant. Answered, the bubble is edited to the verdict and loses its
buttons. In-memory; a tap on a forgotten bubble gets "expired". Accepted
`workspace_create_repo` → `POST /workspaces create=true`, then the engine
sets the active workspace, opens a session and enters code mode (what `/new`
does). To gate another tool: take `ctx.approve` in its handler — nothing
else changes.

**Files.** The agent delivers a file by NAMING a `/workspace/...` path in
its reply — bare, or `MEDIA:/workspace/...` for a path that does not read
as prose. `mediaTags.ts` finds them (code spans and blockquotes are shown,
never sent; a `MEDIA:` inside a JSON string value is a tool echo, ignored),
maps `/workspace` to the session's `work/<id>`, confines by realpath to
that dir, and picks the send method by extension (`deliveryKind`);
`sink.ts` strips `MEDIA:` tags while streaming and sends the files AFTER
the final text, reporting a failed send instead of swallowing it. Bare-path
delivery needs nothing in the prompt, so old sessions have it; the prompt's
`SENDING_FILES` block teaches the `MEDIA:` form. All offsets in
`mediaTags.ts` and `entities.ts` are UTF-16 code units — never
`Array.from` a string there.

**Voice.** Deepgram-only (`deepgram.ts`: two REST calls, no ffmpeg), heard
with the `voice_stt_model` setting — the same model the cli's voice pane
uses. The key is read first (no key → no download); the ✍ reaction and the
Telegram download run together; the ✍ comes off on every exit. Failures are
three sentences (`NOT_HEARD`: no key / unreachable / vendor). Deepgram and
the Telegram byte fetch ride `connect.ts` — 2 s connect cut, a failed
connection retried once, a slow answer never cut, keep-alive under
Deepgram's 5 s idle close — the SAME policy the sidecar runs (`bot.py`);
change one, change the other. `connect.ts` uses undici's own `fetch`: Node's
bundled undici is a different major and refuses the package's Agent.
Reactions are spelled as escapes (a picker-pasted glyph carries a variation
selector Telegram rejects). `telegram_transcript_echo` posts the transcript
back before the turn.

**The webhook URL is never configured** — always
`https://PHANTOM_BACKEND_ADDRESS/telegram/webhook`, the same fact the https
profile runs on (dev points it at ngrok). `reconcile()` registers/tears
down at boot and on any `telegram_*` write (poked from the settings routes
like the looper); it reads `getWebhookInfo` first and keeps the pending
queue. The streaming reply (`sink.ts` + `bubble.ts` + `entities.ts`) reads
the SESSION FEED — parts are published in one place (`runCodingTurn`); the
bubble subscribes, exactly as the turn route does. `client.ts`,
`entities.ts`, `bubble.ts`, `attachments.ts`, `mediaTags.ts` are ported
from `../shockwave`; their decisions (UTF-16 offsets, magic-byte image
typing, `voice`≠`audio`, `telegram_sent` at the client level, the masking
in `mediaTags`) are fixed bugs, keep them.

## Git — AUTO-PUSH (git/autoPush.ts)

No background git: no watcher, no timers, no base merges, no PRs. Work
reaches base in ONE operation: (1) commit everything, `--no-verify`, message
model-written from the diff on the Git Fixer's config (3 tries, file-name
fallback), `Phantom-Session: <id>` trailer → (2) merge origin/<base> in →
(3) conflict? the Git Fixer, `auto_push_fix_attempts` tries, same directory,
no time limit → (4) verify: clean `status --porcelain` AND `--diff-filter=U`
empty AND origin/<base> an ancestor of HEAD (never a `=======` grep);
nothing ahead of base → result `nothing` → (5) push the branch (the backup)
→ (6) `git push origin HEAD:<base>` — a PLAIN merge push, fast-forward by
construction, deliberately NOT a squash (a squash the branch does not
contain makes every later auto-push a false self-conflict) → (7) base moved?
back to 2, three rounds, then give up with the branch intact. Merge, never
rebase; no push is ever forced.

## Git — AUTO-PULL (git/autoPull.ts)

The mirror: base INTO the session branch, on demand, nothing lands on base.
(1) fetch + `rev-list --count HEAD..origin/<base>`; 0 → `clean`, nothing
committed (a no-op pull never mints a commit or spends a model call — this
fetch is repeated inside `mergeBase`, a deliberate no-op round trip so that
primitive stays whole) → (2) dirty tree? commit everything, same message
model + trailer as auto-push (commit-first, never `--autostash`: a stash
re-applied after the fixer is a second conflict surface the fixer never sees)
→ (3) `mergeBase` → conflict? the Git Fixer, same hook → (4) verify
(`verifyResolved`) → (5) push the branch (the backup; a failed push keeps
`merged` with `pushed:false` + reason — the sync happened). No rounds:
nothing races a pull. Result `merged | clean | blocked | error` with
`arrived` (the base commits) and `files` (what the merge changed).

Callers: the CODING agent's `git_auto_pull` (core `codingGitTools`, both
coding kits — cli and server; a plan-mode kit drops it), the cli Assistant's
`git_auto_pull` (App's `autoPull` prop), the Telegram Assistant's
`git_auto_pull` (`telegram/assistant.ts`, over `injectFetch`). No slash
command, no setting.

Triggers: `POST /git/auto-push` (the cli's `/auto-push` — always pushes)
and `PATCH archived=true` on a card that is in `done` AND was unarchived,
when `auto_push_on_archive` is on: the card's newest loop row names the
coding session that pushes (a card with no loop just archives); a held lock
is retried 30× at 10s (`session stayed busy`); a failed push un-archives
the card into `blocked` with the reason. `/git/push`, `/git/pull` (conflicts
to the Git Fixer), `/git/status` stay manual; sweep never deletes unpushed
work.

Remote failures carry MEANING: `git()` re-throws with git's stderr as the
message; `classifyGitFailure` reads it into `credential_invalid` /
`credential_insufficient` / `repo_not_found` / `upstream_unreachable` —
session create and the seed push answer with those and point at /keys.
`GET /github/whoami` checks the stored `github_token`; `GET /github/repos`
lists what it can see (the cli's existing-repo picker). `remote.ts` never
embeds credentials in a URL. GitHub REST calls use GitHub's real paths; the
test fake serves the real paths.

## The board (api/routes/kanban.ts + db/workspaceSchema.ts)

Per workspace: schema `wsp_<id>` holds `cards` + `card_revisions` + the
revision trigger (every update records the OLD values of the changed keys,
every delete the whole card, any write path). Schema versions v1 cards +
revisions · v2 `resolution` · v3 auto modes (`auto_plan`/`auto_build`
replace `supervised`) · v4 `pinned`. Columns are `DEFAULT_COLUMNS` (core);
`workspaces.kanban_columns` exists, nothing edits it. Card numbers
`<prefix>-<seq>` (`card_prefix`, workspace-only, default from the repo
name).

- The board GET returns `{prefix, columns, workspace, cards, card_sessions,
  auto_plan_default/_source, auto_build_default/_source}`; `card_sessions`
  = `[{card, id, name}]`, each card's newest loop row's coding session, one
  query. Order `status, pinned desc, pos, id`. Archived cards never ride
  the board payload (the archive grows forever): `?archived=only` is their
  own listing (newest `updated_at` first — no archived_at column exists;
  keyset-paged), `?seq=` the one-card lookup for a card off the board.
- The board is PUSHED, never polled: every card write in the system lands
  on these routes (the cli, the Assistant's kit, the supervisor's move and
  tick, the coder's block, the engine's own PATCHes — all HTTP clients of
  this one process), and each handler publishes on `api/boardEvents.ts`
  (`ctx.events`; index.ts makes one, app.ts guarantees one). `GET
  /workspaces/:id/events` streams it as ND-JSON: `{event: card, card}` on
  create/update (the full row — the auto-push-failure un-archive too),
  `{event: deleted, id}`, `{event: session, card, id, name}` when the
  engine writes a loop row (the one write only it knows about), a
  heartbeat every 15s. No replay: the cli loads on connect and again on
  reconnect. One api process, so an in-process emitter is the whole bus.
- Requirements: ONE list of `{key, text, done}`; keys are short random
  server-assigned ids, frozen, only ever copied from a read/write result;
  `items` ops add/edit/remove/tick by key, all-or-nothing under the row
  lock, unknown key names the real keys; a whole-list send exists for create
  and the cli's form editor. `done` means VERIFIED.
- `auto_plan`/`auto_build`: boolean, null = inherit the workspace setting.
  `pinned` sticks a card to the top of its column as a group. `resolution`
  is the human's answer to a block, cleared when delivered.

## Settings — one flat store (settings.ts + store.ts)

A row is `(scope, namespace, key)`, plain `value` or encrypted `value_enc`
(CHECKs make a plaintext secret unrepresentable). Namespaces (migration
010): `general` — every key declared in code, unknown keys refused — and
`secret` — user-named secrets, walled off by the namespace filter on every
general read. Resolution: code default → global → workspace → session, most
specific wins, one read (`computeLayers`). Null clears at every layer and
is never stored; a nullable key MUST default to null (boot-enforced).
Adding a key = `DEFAULTS` + `DESCRIPTIONS` + `META` (TypeScript-enforced;
`META.group` ∈ sessions | containers | limits | git | model | voice |
board | telegram) + `SCOPED` if not global-only. Defaults live in code; the
DB stores only overrides.

Global-only unless marked (w = +workspace, s = +session):
`spare_clones`(w) `maintenance_interval_ms` `spare_clone_refresh_ms`
`spare_clone_max_age_ms` `session_idle_destroy_ms`(w,s) `container_idle_ms`
`container_memory_mb` `container_cpus` `container_pids_limit`
`initial_history_depth`(w) `container_image`(w) `container_docker`(w) `bash_timeout_ms`
`bash_timeout_max_ms` `max_read_bytes` `max_search_results`
`max_bash_output_bytes` `session_lock_ttl_ms` `auto_push_on_archive`(w,s)
`agent_git_credentials`(w) `auto_push_fix_attempts`
`git_fixer_provider/_model/_base_url` `card_prefix`(WORKSPACE ONLY)
`provider` `model` `base_url` `reasoning` `max_steps`
`assistant_provider/_model/_base_url` `voice_enabled` `sidebar_width`
`voice_spoken_voice` `voice_stt_model` `voice_wake_word` `voice_wake_words`
`voice_wake_timeout` `auto_plan`(w) `auto_build`(w) `loop_budget_tokens`(w)
`supervisor_provider/_model/_base_url` `boot_last_workspace`
`telegram_enabled` `telegram_authorized_user` `telegram_reply_mode`
`telegram_transcript_echo`.
CREDENTIALS: `github_token` (also per-workspace — the credential chain IS
the settings chain), `anthropic_api_key` `openai_api_key` `google_api_key`
`openai_compatible_api_key`, `deepgram_api_key`, `firecrawl_api_key`,
`telegram_bot_token`.

The coding agent's `provider model base_url reasoning max_steps` is the
base; the supervisor, Assistant and Git Fixer trios resolve through core
`agentModelConfig`'s cascade — a bad cross-provider pair surfaces at agent
BUILD (blocked card, cli notice, auto-push step), never at write.

**Secrets** (namespace `secret`): the CODING AGENT's tokens, not phantom's
credentials. One row per secret — token in `value_enc`, description in
`value` (the one-value CHECK relaxed for this namespace) — so listing never
decrypts. Layers global + workspace, workspace wins a name; names
`[a-z][a-z0-9_]{0,63}`; overwrite IS the update path. A secret named
`github_token` can never shadow the credential. The index (names +
descriptions) rides `POST /sessions` and freezes into the coding prompt;
`secret_list` is the live view; a fetched value lands in the transcript by
design.

## Tools, containers, tasks

- **Everything the agent touches goes through the container.**
  `Sandbox.run` (workspace/sandbox.ts) is the only container-SDK caller:
  argv only, never a shell string (a shell exists only when the agent calls
  `bash`); `Tty: false` always; WorkingDir `/workspace/repo`; 3 retries on
  broken-pipe/OCI/not-running; `maxBytes` is a soft collection cap (default
  32MB — the process keeps running); `timeoutMs` destroys the stream and
  throws `exec_timeout` — it does NOT kill the process, the caller must.
  Reads are `cat`; writes `sh -c 'cat > "$1"'` over stdin.
- Docker exec via the API socket (dockerode), never the docker CLI; the api
  never touches the socket directly under compose (proxy only). A
  just-started container can fail exec-spawn briefly. Bind-mount roots come
  from `/tmp` (Docker Desktop shares it on macOS, where it IS /private/tmp) —
  `test/harness.ts` `testRoot()` is the one place that path is named;
  VirtioFS squashes uids.
- **Docker inside the workspace** (`container_docker`, on by default,
  workspace-scoped): the container is created PRIVILEGED with an anonymous
  `/var/lib/docker` volume (`buildContainerSpec`), so the agent runs its OWN
  nested dockerd — `docker build/run/compose` against its own daemon, never
  the host's (the api never shares its socket). The volume gives that daemon
  the overlay2 graph driver; nesting on the container's overlay upperdir
  would fall back to vfs. The daemon is NOT started for you: the image bakes
  `docker` + the `agent` user in the `docker` group + a `start-docker` helper
  (idempotent, `sudo dockerd &` then waits), and the agent runs it on demand,
  so idle sessions cost nothing. The volume dies with the container (every
  `remove` passes `v: true`). Privileged is a WEAKER boundary than the
  default container — a hostile workspace can reach the host — so turn the
  setting off for a hardened one; the container was always light sandboxing,
  not a security wall. No host package is required (privileged, not sysbox).
- **Docker's API cannot kill an exec** (moby#9098). Unary bash rides a
  wrapper that writes `$$` to a pidfile — the exec'd process is already a
  session leader (runc setsids it; NEVER the `setsid` binary, which forks
  and eats the exit code), so that pid names the whole tree. Esc (client
  abort → `reply.raw` `close` with `writableFinished` false, the one
  disconnect signal that works after the body was read) and the exec
  timeout both kill via a SECOND exec: `pkill -s <sid>` (busybox builtin
  and procps alike; `kill -- -pgid` is not portable), TERM → 1s → KILL.
- The registry (`tools/registry.ts`): `bash` (cmd/cwd/timeout/detached),
  `read` (offset/limit; images as base64 ≤ 4MB; binary refused), `write`,
  `edit` (single or `edits[]`, all-or-nothing, fuzzy chain, returns strategy
  + unified diff, re-reads to verify), `ls`, `find` (`rg --files`), `grep`
  (`rg --json`). Bash semantics are injected by the route via `ToolCtx` —
  the registry has no db/docker. Credential-bearing git runs in the API
  process behind the guard set; `agent_git_credentials` (off by default)
  puts the token in the container env, per workspace, dies with the
  container.
- **Tasks** (`api/routes/tasks.ts`, migration 011): `GET /sessions/:id/tasks`
  → `{container: absent|stopped|running, tasks[], recent[]}` from
  `ps -eo pid,sid,etime,args` INSIDE the container (never `docker top` —
  host pids cannot meet a container pkill), grouped one task per sid, sid 1
  (docker-init + `sleep infinity`) and the probe's own ps dropped; each
  `{sid, command, cmd_id, logs, log_file, started_at, elapsed, pids}`
  matched to `commands` rows by the sid captured at detached spawn; running
  rows with no live sid are closed on read (15s grace for a null sid);
  `recent` = last 10 finished rows. `DELETE …/tasks/:sid` → 404 unless live
  and non-baseline; marks the row `killed` BEFORE killing. Never starts a
  container.
- Skills: two tiers merged at every meeting point, repo wins — the repo's
  `.agents/skills/` and the image's `/opt/skills/` (`systemSkills.ts`).
  `POST /skills` writes the repo tier only. Scanned at session creation and
  frozen into the coding prompt.
- Web: Firecrawl with `firecrawl_api_key` read at point of use; fetched
  markdown lands at host `work/<id>/web/<name>.md` = container
  `/workspace/web/<name>.md`.

## DB and migrations

`db/migrate.ts` applies `migrations/*.sql` in filename order, one
transaction each, recorded in `public.schema_migrations`; `upTo` is a test
seam. Postgres aborts the transaction on an errored statement — use
savepoints where a refusal is expected mid-transaction. Deletion paths fail
closed; stocking fails open.

001 the whole control plane (settings, workspaces, sessions, transcripts,
commands, workspace_schema_state) · 002 one transcript per session · 003
folders + loops (branch/claim/card leave sessions) · 004 `auto_push_fix_*`
→ `git_fixer_*` · 005 transcript + `tokens_*` onto sessions · 006
`supervisor_enabled` → `auto_plan` + `auto_build` · 007 `name`,
`turn_count` · 008 `name_manual` · 009 `plan_mode` · 010 `namespace` in the
settings primary key · 011 `commands.sid` · 012 telegram (account,
sent-bubble map, update dedup). Every migration is forward-only and applied
at boot; the dump/restore path REQUIRES the same `ENCRYPTION_KEY` or every
carried credential is unrecoverable.

## Deploy-side gotchas that live in this tree

- `POST /update` writes ONE trigger file (tag regex
  `^v[0-9]+\.[0-9]+\.[0-9]+$`, enforced identically in the route, the
  updater's watch.sh and apply.sh — `test/deploy.test.ts` pins agreement).
- The host files ride in the api image at `/host-files`; no script holds a
  file list. `install.sh` makes exactly one symlink,
  `/usr/local/bin/phantom-backend`.
