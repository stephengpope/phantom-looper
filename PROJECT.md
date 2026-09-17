# Database clean-up

One table at a time. Every table gets one object that owns it. Nothing reads
or writes a table except through that object. Names say what things are.

## Why

A table with more than one writer is a table nobody can reason about. A file
that can import the DB lib can cheat. A name you have to decode is a bug
waiting to happen. This pass makes each of those impossible, table by table,
and reviews each table's behavior while it is in our heads.

## The rules

- Every read of a table goes through its object. Joins are fine; they live in
  the object of the table being listed.
- Every write goes through its object. Nothing else writes, ever.
- The DB lib (`drizzle`, `pg`, the `Db` handle) is imported only by
  `phantom-backend/db/*` and the table objects.
- Names are descriptive — table, column, function, object. No cryptic or
  clever names, all the way out to the cli, the agent tools and the prompts.
- Nothing raised, nothing deferred. A table is done when every step is done.
  Never say "next" with work still open.

## The steps, per table

1. Find every piece of code that touches the table — reads, writes, joins,
   callers of callers. File and line for every claim.
2. Understand why the table exists. Should it stay?
3. Report findings and the proposed fix. Wait for go.
4. Seed a real Postgres with this table's awkward cases.
5. Every read through the object.
6. Every write through the object.
7. DB lib out of any file that should not have it.
8. Rename anything cryptic, all the way to the edges.
9. Prove behavior: migration (if any) on old-shape data, every object method,
   the live server over HTTP including the destructive paths.
10. Fix what the proof finds. Re-run.
11. Fix stale comments and docs in every touched file.
12. Typecheck both packages (`npx tsc --noEmit && npx tsc -p phantom-cli
    --noEmit`). Clean up the scaffolding. Report.

## The tables, simplest first

| # | table | object | status |
|---|---|---|---|
| 1 | ~~`workspace_schema_state`~~ | — | **done** — deleted |
| 2 | `folders` | `Folders` (folders.ts) | **done** |
| 3 | ~~`loops`~~ | — | **done** — deleted; the card moved onto `sessions` |
| 4 | `presets` | `Presets` (presets.ts) | **done** |
| 5 | ~~`commands`~~ `background_tasks` | `BackgroundTasks` (backgroundTasks.ts) | **done** — renamed |
| 6 | ~~`token_usage`~~ `log_tokens` | `LogTokens` (logTokens.ts) | **done** — renamed |
| 7 | `telegram_update` | `TelegramStore` (telegram/store.ts) | |
| 8 | `telegram_sent` | `TelegramStore` (telegram/store.ts) | |
| 9 | `telegram_account` | `TelegramStore` (telegram/store.ts) | |
| 10 | `workspaces` | `Workspaces` (workspaces.ts) | |
| 11 | `card_revisions` | `Cards` (cards.ts) | moved + renamed in #1; keyed by `card_id` in #3; review still owed |
| 12 | `cards` | `Cards` (cards.ts) | moved + renamed in #1; review still owed |
| 13 | `settings` | `Settings` (settings.ts) | |
| 14 | `sessions` | `Sessions` (sessions.ts) | |

Main-schema migrations: `migrations/*.sql`, run by `phantom-backend/db/migrate.ts`.
Drizzle mirror: `phantom-backend/db/schema.ts`. Objects are built once in
`phantom-backend/index.ts` and handed to everything else.

## Table 1 — `workspace_schema_state` (done)

**What it was.** Each workspace had a private Postgres schema (`wsp_<id>`)
holding its own `cards` and `card_revisions`. This table tracked which
migration version each private copy was at. That meant a second migration
system (`db/workspaceSchema.ts`), DDL running inside the create-workspace
route, a raw `pg.Pool` on the API context, and `Cards` on raw SQL because
drizzle cannot address a schema named at runtime.

**What we did.** Migration `024_one_cards_table.sql` moves every workspace's
cards and history into one `cards` and one `card_revisions` in
`phantom_looper`, keyed by `workspace_id`. Numbers preserved; a per-workspace
counter (`workspaces.next_card_number`) seeded from the old sequence so a
deleted card's number is still never reused. Drops the private schemas, this
table and `workspaces.schema_name`. `Cards` is on drizzle. `pgPool` is off
the API context. The second migration system is deleted.

**Renamed.** `seq` → `number` (the card number — "PHA-7 is card 7"). API
field, cli, agent tools, prompt blank `{{number}}`. `card_revisions.seq` →
`card_number`. `bySeq` → `byNumber`.

**Bug the proof found.** Workspace delete cascades to cards; the history
trigger then tried to record each deletion for a workspace that was already
gone → FK error. The trigger now skips when the workspace no longer exists.

## Table 2 — `folders` (done)

**What it is.** A checkout's identity: the branch, and the commit it was
cut from. Shares its session's id (directories keep their names). The row
outlives the files so destroy/restart and duplicate know the branch.

**State found.** Clean: one writer (`Sessions.create`), every read through
`Folders`, the one join in `Sessions.list` (allowed). Nothing to untangle.

**Renamed.** `claim_sha` → `cut_from_sha` — it is `HEAD` right after the
checkout (base's tip for a new session, the source branch's tip for a
duplicate), read once by `/git/status` to count base's commits since.
"Claim" named the pool mechanism, not the fact. API: `cutFromSha`,
`/git/status` field `sinceClaim` → `sinceCut`. Migration 026.

**Bug the proof found.** `sessions`, `folders` and `loops` all said
`on delete restrict` to workspaces, so a workspace with ANY session row —
destroyed included — could never be deleted: the route refused only ACTIVE
sessions, then hit the FK and 500ed. Now cascade (026), like cards already
did. The route still refuses while sessions are active.

**Found on the way, fixed first (own pass).** Reading `folders` callers
turned up the transcript header: nine hand-built copies of a line-1 record
nobody read except `system_prompt`, one copy writing a folder id where a
branch went, one freezing an empty prompt. The prompt was one glued string
cut back into its two cache pieces by prefix-matching on every turn. Now
`sessions.system_prompt = { base, workspace }` (025), frozen once at
create, sent verbatim; the header, its type and all nine builders are gone.

## Table 3 — `loops` (done)

**What it was.** One row per looper run: this card, this coding session,
this supervisor session. Written only when the looper ran a round, so it was
the ONLY link between a card and a session — a session could be on a card
only because the looper put it there, and the card number rode a pairing
row instead of the session. Linked by card number, not the card's key.

**What we did.** `sessions.card_id` (027) — the card a session works on,
keyed to `cards.id`, `on delete set null`. A coder and its supervisor both
carry it. The pairing is derived, not stored: a card's coder is its newest
coding session (`Sessions.coderOf`), its supervisor its newest supervisor
session (`supervisorOf`); the board reads `codersByCard`. The looper puts
the coder on the card at birth (`setCard`) and gives it a supervisor born
for it — a supervisor older than the coder is replaced. `loops`, `Loops`
and `loops.ts` are gone. The session API still says `card: 7` (the number),
now read off the card row. Rule set here: **storage links use `cards.id`;
people and agents address cards by number.**

**Also.** The session list's card column (`cardStatus`) now rides the same
join instead of one extra query per workspace; `Cards.statusOf` is gone.
`autoPull`/`autoPush`/`sync`/`digest`/`sessionTitle` no longer take a
`loops` dependency they never used or now do not need.

**Bug the proof found.** The old list joined `loops` on either seat AND
`token_usage`, then summed: a session in two loop rows (003-era data)
doubled its token totals — 200 stored came back as 400. One card per
session now; the seed proved 200.

**Same rule, `card_revisions` (028).** It linked by `(workspace_id,
card_number)`; now `card_id references cards(id) on delete cascade`, the
two old columns dropped. History goes with its card — the trigger records
updates only; the 'delete' revision (a whole card copied into a row nothing
read) is gone, as are revisions of cards already deleted.

**Token totals are numbers.** The session list's `SUM` over `token_usage`
came back from pg as text (`"200"`) under a `number` type; the cli only
worked by coercion. `mapWith(Number)` at the query.

## Table 4 — `presets` (done)

**What it is.** A named snapshot of the 15 model keys (provider / model /
base_url / reasoning / max_steps, for the coding agent, the assistant and
the supervisor). Each key is set, `null` = clear, or absent = leave alone.
Applying is the client's move: it sends `values` as the body of
`PATCH /settings` — one write path, one set of rules (cli `Presets.tsx`,
Telegram `/presets`).

**State found.** Clean: `Presets` is the only importer of the table, the
three routes go through it, nothing joins it. Names already say what they
are. No migration, no rename.

**Bug the proof found.** `name` is unique, and `save` did not know it: a
new preset (or a rename) with a name already taken hit the constraint and
came back **500** with `duplicate key value violates unique constraint
"presets_name_key"`. Now `PresetError('duplicate_preset_name')` → 400, and
the cli shows `a preset named "fast" already exists`.

**Stale.** The cli said "the 11 model keys" in four places; there are 15.

## Table 5 — `commands` → `background_tasks` (done)

**What it is.** One row per detached bash command a session's agent runs:
what it ran (`argv`), its log file, its process-tree id (`sid`), and how it
ended (`running` → `exited` / `killed` / `orphaned`). The customer sees
these on `/tasks`; the agent reaches them through `task_list` /
`task_wait` / `task_kill`. Stays.

**State found.** Clean on the rules: one object, one writer, no joins, DB
lib contained. The name was the problem: "command" already meant the cli's
slash commands (`phantom-cli/commands.ts`) and the Telegram bot's commands
(`telegram/commands.ts`) — three meanings, one word — and the storage said
`commands` / `cmd_id` while every edge said task.

**Renamed (029).** Table `background_tasks`; object `BackgroundTasks`
(`backgroundTasks.ts`); `CommandRow` / `CmdRow` / `CommandEnd` →
`BackgroundTaskRow` / `BackgroundTaskEnd`; `cmd_id` → `background_task_id`
in the `bash` detached result, `task_list` / `task_wait` / `task_kill`
(input and output), the `/tasks` payloads, the cli's `Tasks.tsx` and the
coding prompt; the log stream `/commands/:cmdId/logs` →
`/background-tasks/:id/logs`, moved out of `routes/git.ts` (where it never
belonged) into `routes/tasks.ts`. Constraint names follow the table.

**Kept.** `/tasks`, the `task_*` tool names and `/sessions/:id/tasks` —
the customer's and the agent's shortcuts, unambiguous where they sit.
`sid` — a real Unix term, documented as such.

**Proof.** 029 on 028-shape rows in every state (running with and without
a sid, exited, killed, orphaned, on a destroyed session) — rows, cascade
and constraint names intact. Every object method, including the
first-terminal-write-wins rule. Live: a real session container, detached
`bash` → `{background_task_id, log_file}`, `task_list`, `task_wait` (done /
running / unknown / old field name refused), `/tasks`, the log stream (old
path 404s), kill by sid, `task_kill` (second kill idempotent), session
delete cascades the rows. Nothing found wrong in this table.

**Found on the way, fixed.** `POST /workspaces` for a repo already
registered → 500 `workspaces_owner_name_key`. Same class as table 4's bug.
The one reusable fact — "this pg error is a unique violation" — is now
`isUniqueViolation` in `db/client.ts`; presets and workspaces both use it,
each with its own refusal (`duplicate_preset_name` 400,
`already_registered` 409).

## Table 6 — `token_usage` → `log_tokens` (done)

**What it is.** One entry appended per model call, by sessions and helpers
alike (coding, supervisor, assistant, title, commit_message, compaction,
session_digest): what it cost in tokens, which model, which session if
any. Every model handle is wrapped in core (`createAgent.ts`) so no call
can skip it. Server writes through `LogTokens.record`; the cli posts to
`POST /log-tokens`, which calls the same method. `session_id` is
deliberately not a foreign key: the spend report is by date and outlives
the session.

**State found.** Clean on the rules: one writer, readers through the
object plus the sessions-list join. The name was wrong: `token_usage`
reads like a total you look up; the table is a log you append to.

**Renamed (030).** Table `log_tokens` (indexes follow); object `LogTokens`
(`logTokens.ts`); `POST /token-usage` → `POST /log-tokens`. The two report
routes (`/sessions/:id/token-usage`, `/system/token-usage`) keep their
names — they are the reads. `TokenRecord` was half snake, half camel
(`sessionId` … `cache_read`): now `cacheRead` / `cacheWrite`, through
core's emit, the POST body and `record`.

**Also.** One rule for bigint sums — `mapWith(Number)` at the query, as
`Sessions.list` already did — replacing `sql<number>` + `Number()` after,
three times in the object and again in the report route. Four stale
comments gone (`turn.ts` orphan doc, `system.ts` pre-022 fragment,
`sessions.ts` "cached columns being phased out", `schema.ts` now says why
`session_id` is un-keyed).

**Proof.** 030 on 029-shape rows (null session, a session that no longer
exists, a 3-billion-token row, an old row outside the window): rows and
index names intact. Every method, totals as numbers. Live: `POST
/log-tokens` (old field names and old route refused), the session's
totals, the list's totals, the report text, session delete leaving the
spend in place. Nothing found wrong in this table.

**Every model call is recorded, with nothing to remember.** Confirmed by
trace: `languageModel()` (`core/llm/createAgent.ts`) is the only place a
provider model is built and it wraps each one in the recording
middleware; nothing else imports a provider SDK or calls
`generateText`/`streamText`. Two doors reach it:

- **Agents** are classes on one base, `PhantomAgent`, and the class name
  is the billing kind: `class CodingAgent extends PhantomAgent` bills to
  `coding`, read off the name at construction (`kindOf`). Before, the
  three factories were functions and every caller typed `usage: { kind:
  'coding', … }` by hand — a new agent that forgot recorded nothing,
  silently. Now there is no kind field and nothing to pass but the
  session id; a class whose name is not a `TokenKind` throws when built.
- **Helpers** are classes on one base, `PhantomHelper`
  (`core/llm/helper.ts`), the same way: `class TitleHelper extends
  PhantomHelper` bills to `title`. Four exist — title, commit message,
  session digest, compaction — each in the file that uses it. Compaction
  used to be hand-wired at four call sites, each repeating the same call;
  `compact()` owns it now. `helperCall` is gone.

After this, nothing in the code hands a model a billing kind by hand:
`languageModel()` has exactly two callers, the two bases, and both read
the kind off the class name. Proved with a fake provider: all seven
kinds landed one row each with the right kind, session and tokens
(commit message end to end over a real staged diff); a `ReviewAgent` and
a `SummaryHelper` (no such kinds) are refused at construction.

## Insights

What each table taught, written as reusable rules, lives in
[INSIGHTS.md](INSIGHTS.md) — the source for the value system's prompts
later. Add to it in the same pass that earns the lesson.

## How to test

```sh
docker run -d --name pg-test -e POSTGRES_PASSWORD=pw -e POSTGRES_USER=phantom \
  -e POSTGRES_DB=phantom -p 5433:5432 postgres:16
export DATABASE_URL=postgres://phantom:pw@localhost:5433/phantom
# migrations only:   a script calling migrate() from phantom-backend/db/migrate.ts
# live server:       WORKSPACE_ROOT_PATH=/workspace/scratch/ws PORT=8099 API_KEY=testkey \
#                    ENCRYPTION_KEY=$(openssl rand -base64 32) npx tsx phantom-backend/index.ts
# routes live under /api with `authorization: Bearer <API_KEY>`
```

Registering `https://github.com/stephengpope/phantom-looper` as a workspace
needs no token (public repo) and is enough to exercise the board routes.
