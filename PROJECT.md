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
| 2 | `folders` | `Folders` (folders.ts) | **done** — took the checkout facts in table 14 |
| 3 | ~~`loops`~~ | — | **done** — deleted; the card moved onto `sessions` |
| 4 | `presets` | `Presets` (presets.ts) | **done** |
| 5 | ~~`commands`~~ `background_tasks` | `BackgroundTasks` (backgroundTasks.ts) | **done** — renamed |
| 6 | ~~`token_usage`~~ `log_tokens` | `LogTokens` (logTokens.ts) | **done** — renamed |
| 7 | ~~`telegram_update`~~ `telegram_handled_updates` | `TelegramHandledUpdates` (telegram/handledUpdates.ts) | **done** — renamed |
| 8 | ~~`telegram_sent`~~ `telegram_sent_messages` | `TelegramSentMessages` (telegram/sentMessages.ts) | **done** — renamed |
| 9 | ~~`telegram_account`~~ `telegram_bot_state` | `TelegramBotState` (telegram/botState.ts) | **done** — renamed |
| 10 | `workspaces` | `Workspaces` (workspaces.ts) | **done** |
| 11 | `card_revisions` | `Cards` (cards.ts) | **done** |
| 12 | `cards` | `Cards` (cards.ts) | **done** |
| 13 | `settings` | `Settings` (settings.ts) | **done** |
| 14 | `sessions` | `Sessions` (sessions.ts) | **done** |

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

## Tables 7–9 — the Telegram tables (done)

**What they are.** You text the bot from your phone; it answers as the
assistant or as a coding session's agent. Three tables carry that:

- `telegram_account` → **`telegram_bot_state`**: the ONE row (id pinned 1)
  — who answers a plain message (`mode`), the active session and workspace,
  and the webhook registration (secret encrypted at rest, URL, bot name).
- `telegram_sent` → **`telegram_sent_messages`**: one row per message the
  bot sent. A reply or reaction carries only (chat, message id); this says
  which conversation the bubble belongs to and what it said.
- `telegram_update` → **`telegram_handled_updates`**: one row per Telegram
  `update_id` already handled. Telegram re-delivers an update it did not
  get acknowledged; the repeat loses the insert and is dropped. "Update"
  is Telegram's own name for the envelope (message, reaction, button tap).

**State found.** Clean on the rules — one object (`TelegramState`,
`store.ts`) wrote all three, DB lib contained, no joins. The names said
"Telegram" and nothing about what a row is; PROJECT.md called the object
`TelegramStore` and the code `TelegramState`. Two real problems under
them:

- **Dangling pointers.** `active_session_id`, `active_workspace_id` and
  `origin_session_id` were bare text. A deleted session or workspace left
  the pointer standing; five readers re-checked "does it still exist?" and
  `/new` could post into a deleted workspace.
- **One fact, two columns.** `telegram_sent.origin` (`'assistant' |
  'session'`) plus `origin_session_id`; the read already collapsed them.

**What we did (031).** Three tables, three objects, one per table like
tables 2–6: `TelegramBotState` (`read`, `setMode`, `setActiveSession`,
`setActiveWorkspace`, `saveRegistration`, `clearRegistration`),
`TelegramSentMessages` (`record`, `delete`, `get`, `lastForSession`),
`TelegramHandledUpdates` (`markHandled`). The pointers are foreign keys:
session and workspace delete clear `telegram_bot_state`'s (`set null`); a
session's bubbles go with it (`cascade`) — a reply to one answers nothing
to switch to. `origin` is dropped; `session_id` alone, null = the
assistant's bubble. Index on `(session_id, sent_at desc)` for the
last-message read and the cascade. `setMode` reads through `read()`
instead of its own query. The engine's `SentOrigin {kind, sessionId?}` is
`string | null`; locals named `account`/`acc` are `bot`.

**Kept.** `mode` with `'assistant' | 'code'` — `/code` and `/assistant`
are the customer's shortcuts and the column reads as they do.
`webhook_secret_enc` — `_enc` is the convention `settings.value_enc` set.

**Proof.** 031 on 030-shape rows: a pointer at a session and a workspace
that no longer exist (cleared), a `'session'` bubble with no id and an
`'assistant'` bubble carrying one (both now null), a bubble for a session
that was gone (dropped), a bubble for a destroyed session (kept — the row
outlives the files); constraint and index names follow the tables. Every
object method (33 checks) including the foreign keys refusing an unknown
session/workspace, a secret stored under a rotated key reading as null,
the one-row check, upsert, prune, and the two cascades. Live over HTTP
with a fake Telegram API preloaded into the server (19 checks): reconcile
registers and saves the webhook; wrong/missing secret 403; a stranger
ignored; the same `update_id` twice answered once; `/workspaces 1`,
`/new`, `/code`, `/assistant` move the row; a reply to a coder bubble
switches into its session; session purge clears the pointer and drops the
bubble, and a reply to that bubble afterwards is just a plain command;
workspace delete clears its pointer; disabling tears the webhook down and
the route goes quiet. Nothing found wrong in the code beyond the above.

**Found on the way, not ours.** Telegram's `/sessions` lists only sessions
something was typed into (`?typed=true`), so a session just created over
the API is invisible to it until its first message; `/new` is the
Telegram path. By design as far as the code says; noted, not changed.

## Table 10 — `workspaces` (done)

**What it is.** One row per registered GitHub repository: owner, name,
human label, base branch, the prefix for session branches, the board's
column list, and the card-number counter. Stays.

**State found.** Every read through `Workspaces`, names already
descriptive. Three things under that:

- **A second writer.** `Cards.create` moved `next_card_number` itself
  (`cards.ts:136`). Now `Workspaces.claimCardNumber(id, tx)` — in the
  caller's transaction so the number and the card land together; `Cards`
  holds a `Workspaces`.
- **Two truths.** `url` was always `https://github.com/{owner}/{name}.git`,
  written from owner and name at registration, read by one place (the
  clone's auth). Dropped (032); the API response and `resolveAuth` derive
  it with `remoteUrl(owner, name)`.
- **`DELETE /workspaces/:id` of a workspace that did not exist returned
  200 `{deleted}`** — the confirm gate only ran when the row existed.
  Now 404 first.

**Kept.** `kanban_columns` — nothing writes it yet (the board always
shows the default list); the builder's call: editable columns are a
planned feature without an interface, the column stays for it.

**Stale.** POST's description still said it created a per-workspace SQL
schema (gone since table 1); `remove`'s comment said the schema drop was
the caller's.

**Proof.** 032 on 031-shape rows (two repos, one with a card and a moved
counter): column gone, rows intact, clone URL derived with case kept.
Every method (14 checks): the counter hands out and moves on, a
rolled-back transaction leaves it alone, a deleted card's number is never
reused, duplicate owner/name refused, cascade to cards. Live (13 checks):
register (url in the response), duplicate 409, GET one and list, PATCH
own field + setting, `base_branch` uncleareable, cards numbered 1, 2,
delete 2, next 3, a session cloned through the derived URL, DELETE
unknown 404, with a session 409, without confirm 409, with confirm 200,
then 404.

**For table 12.** The card routes take `:cardId` = `cards.id` (`DELETE
/workspaces/:id/cards/:cardId`, `cards.remove(w, id)`), while the rule
since table 3 is that people address cards by number. Owed to the cards
review.

## Tables 11–12 — `cards` and `card_revisions` (done)

**What they are.** `cards`: the board — one row per card, numbered per
workspace (PHA-7 is card 7, never reused), status a column name, the one
requirements checklist, the per-card looper switches, archived or not.
`card_revisions`: one row per update, written by a trigger so a SQL edit
is recorded too — the OLD values of the keys that changed, when. Two
readers: the history tool (`kanban_card_history`, cli and Telegram) and
the looper's "entering plan is a new run" clock (`lastMovedAt`). Both
stay.

**State found.** One object; the only other importer is `Sessions` for
its five joins (allowed); every write in the code goes over the routes
(looper, `index.ts`, Telegram, cli). Under that:

- **Two ways to name a card.** `Cards.update` / `remove` and the
  `PATCH` / `DELETE` routes took `cards.id`; every other method and route
  took the number. The Telegram assistant fetched the whole board,
  archive included, on every write just to turn a number into an id;
  `LoopCardConfig` carried both.
- **`card_revisions.op` had one value.** Since 028 the trigger writes
  updates only; every row said `'update'` and the history tool still
  returned it.
- **`update` read the before-state outside its transaction** — two
  simultaneous moves could both report the same `from` on the board
  event.
- **Four stale docs said a deleted card keeps its history** (history
  tool description, cli `kanban.ts`, `board.ts`). Not since 028.

**What we did (033).** Routes `PATCH` / `DELETE /workspaces/:id/cards/:number`;
`/workspaces/:id/revisions?card=7` → `/workspaces/:id/cards/7/revisions`.
`Cards.update` / `remove` take the number. `cardIdOf` and its board
fetch are gone from Telegram; `cardId` is gone from `LoopCardConfig`; the
looper, `index.ts` and the cli's `BoardStore` send the number (the store
keeps its state keyed by id — `numberOf(id)` at the call). `op` dropped;
`changed` → `changed_from` (it read as the new values; it holds the keys
that changed and what each changed from); a revision is `{changed_from,
changed_at}`. `update` reads the prior row
`for update` inside the transaction — one read for the transition, the
item ops and the not-found. Docs fixed.

**Kept.** `DELETE /cards/:number` — no caller in the code, reachable by
hand; the `deleted` event still carries the row id (the cli keys its
state on it).

**Proof.** 033 on 032-shape rows (a never-moved card, a moved-and-edited
one, an archived one; four `'update'` revisions): column gone, rows,
index and FK names intact, the trigger still records old values only.
Every method (50 checks): reads archived-or-not, the archive page and
total, revisions newest-first with limit, `lastMovedAt` null then the
newest status write, create's counter (a refused create takes no
number), update by number with `from` / `wasArchived` (false → true
once), item ops by case-insensitive key, a bad key refusing the batch,
items + requirements refused, two concurrent moves reporting distinct
`from`s, unarchive-as-blocked, remove taking the history, the number
never reused, `ofSession`, workspace cascade. Live (27 checks): create,
PATCH by number (an id-shaped number 404s, a non-integer 400s), items,
history under its card (old route 404), `?number=` and `archived=only`,
DELETE then 404 / no history / no PATCH / number not reused, the event
stream carrying `from` and the writer. Nothing else found wrong.

## Table 13 — `settings` (done)

**What it is.** One row per explicit override, `(scope, namespace, key)`;
defaults live in code. Chain: default → global → workspace. `general`
holds the declared settings and credentials (value in `value`, or encrypted
in `value_enc`); `secret` holds user-named tokens the agent reads. Stays,
as one table: same shape, same scope rule, one delete clears a workspace's
layer.

**State found.** One owner, one writer, DB lib contained. Under that:

- **cli bug.** The server allows 11 settings per workspace
  (`WORKSPACE_OVERRIDABLE`); the workspace screen showed all 11 but saved
  through `PATCH /workspaces/:id`, which kept its own list of 6. The other
  5 (auto plan, auto build, loop token budget, docker, auto build alerts)
  were stripped by the body schema and answered 400 `nothing to update`.
  Proved on the old code.
- **A column the DB derived.** `secret` was forced equal to
  `value_enc is not null` by the 001 CHECK. Dropped (034).
- **`source: 'override'`** for the global layer; two readers renamed it.
  Now `'global'`.
- **Session layer:** one key allowed it, nothing wrote it. Gone.
- **Dead rows** for 7 keys removed from the code. Deleted (034).
- **The cli's own copies** of 17 server settings' descriptions/defaults
  and 13 credential descriptions, drifting. Deleted; every screen renders
  from GET /settings. `openai-codex` was in the cli's provider list and the
  wizard, and refused by the server's — both now use core's one list.

**Renamed (035).** The coding agent's ten keys had no prefix while the
other two agents' did: `provider` → `coding_provider`, and so on through
`coding_compact_max_tokens`. Storage rows and the keys inside saved presets
carry over; core's cascade, compaction fallback, the looper, Telegram, the
wizard and the presets screen read the new names. Each setting now declares
`group` (an agent or an area) and, inside an agent, `subgroup` (model /
compaction / voice); labels drop the agent's name (`coding_provider` is
"provider" under "coding"). The cli has ONE settings screen built from that
— agents first, then the areas, this machine's audio rows under the
assistant; `/model` and `/assistant` open it at their group. The old
`/model` and `/assistant` pages, and the cli's own lists of which keys each
showed, are gone. `/keys` and `/server` stay apart (masked; offline).

**What we did.** 034. `PATCH /workspaces/:id` takes its 3 own fields only;
workspace overrides go through `PATCH /settings?workspace=` — one door.
`CREDENTIALS` carry label + group + description, served on the wire.
GET /sessions/:id lost its `settings` block (nothing read it). Digest's six
round trips → one `resolveMany`.

**Proof.** 034 on 033-shape rows (11 seeded, 7 kept, column gone, 4 bad
shapes refused); 035 on 034-shape rows at two layers plus three presets
(renamed, nulls kept, others untouched). Every method (42), then the
renamed keys through the object, core's cascade / pin / compaction fallback
and presets (14). Live (44 + 10): the eleven through one route, the 3 own
fields, sources by layer name, credentials at two layers, secrets sharing a
credential's name, workspace delete taking its layer, old key names
refused, a preset round trip. The cli's screen rows composed from the live
payload: heading order, `/model` and `/assistant` landing rows, this
machine's rows under the assistant, `/server` alone.

## Table 14 — `sessions` (done)

**The model, stated first.** A **folder** is a checkout: files on disk, a
branch, a container. A **session** is a conversation; its tools open ONE
folder (`folder_id`) — a coder its own (same id), a supervisor its coder's,
the assistant the on-screen session's. A fact lives on the thing it
describes.

**State found.** On the rules, clean: one owner, every write through it, one
allowed join (`Cards.ofSession`), DB lib contained, names descriptive.
Against the model, four checkout facts sat on the conversation — `status`
(do the files exist), `last_used_at`, `last_push_at`, `work` — and the
"which folder" answer was given three different ways: the row's `folder_id`
on the server (`folderId ?? id`, 16 copies), and three clients quietly
sending the CODER's id instead of their own (cli assistant, Telegram
assistant, the looper's supervisor). That last one was the only reason
reaping worked for a borrowed folder: the supervisor's activity landed on
the coder's row by impersonation. And the assistant, unlike the other two
agents, built its model from settings each turn instead of its row.

**What we did (036).** The four facts moved to `folders` (`on_disk`,
`last_used_at`, `last_push_at`, `work`); `last_used_at` carries over as the
newest touch of ANY session on the folder. `Folders` owns them: `touch`,
`markPushed`, `setWork`, `filesRemoved` / `filesRestored`, `listIdle`,
`countOnDisk`, `listForWorkRefresh` / `listStaleWork` — and the checkout
itself: `checkout` (claim a pool slot or clone, cut the branch, record the
row), `restore` (a restart: the branch the row remembers, from origin) and
`removeFiles` (the unpushed-work refusal, then `rm`), moved out of
`Sessions.create` / `destroy` where they had been written; their refusals
are `FolderError`, mapped by the two routes beside `SessionError`. The
container's docker label (`phantom-looper.session=<id>`) is gone: the
container NAME already carried the folder id and is what everything opens
by, so the running list reads it off the name — old containers match too.
Every session read
is one select shape over one join (`Sessions.view`), so the wire still says
`status`, `lastUsedAt`, `lastPushAt`, `work`, `branch` — shared by every
session on the folder. `folderOf(s)` is the one answer to "which folder"
(`no_folder` when there is none); `ownsFolder`, `isHeld` (was six copies)
and `expiredHold` are the other pure rules. One tool gate
(`api/sessionHeader.ts toolSession`) replaces four copies across fs, web,
skills, git; `ContainerManager.ensure(folderId)`, `activeFolders()`.
The three clients send their own session id; the Telegram assistant's
folder follows a mid-turn switch. The assistant runs on its row's pin
(`pinnedModel`) in both clients — frozen after its first turn like the
other two. `POST /sessions/assistant` and `/follow` return the row.

**A hold that ends by the clock is a death, not a finish** (the builder's
rule). A holder releases when its turn ends; only a crashed window or a
killed process leaves a hold to expire. Nothing hid it before: `heldByOther`
read it as free and the digest skipped it forever. Now `expiredHold(s)`
names who and when; taking over such a session logs a warning (docker
logs); the lock event carries `died_on` / `died_at` on the free record and
on the takeover, and the cli notes it once; the digest includes the session
and tells the model to write it as “⚠️ died on …”, and logs it too.

**Also.** `DELETE /sessions/:id` without purge on a session that owns no
files answers `{already: 'no files'}` instead of marking a conversation
"destroyed"; a supervisor's restart is refused by ownership, not by agent
name. Workspace delete counts folders on disk (`Folders.countOnDisk`) —
assistant and supervisor rows, which are never destroyed, no longer block
it with nothing visible to close. Gone: `getMany`, `createConversation`
(private now), `WorkState` defined twice, `runsCodingAgent`, `git=true` on
`GET /sessions` (accepted, documented, ignored, never sent), the
`branchesOf` walk in the work refresh. Stale comments in routes/sessions,
looper/engine, digest, the cli's `SessionInfo` and `sessionUsage` fixed.

**Proof.** 036 on 035-shape rows (11 checks): an active coder with a
supervisor and an assistant on it — the folder's `last_used_at` is the
assistant's later touch; a destroyed coder and its supervisor; an orphan
folder with no owner row (off disk, `created_at` as its touch); an assistant
with no folder; constraints intact. Every method and rule (42): the view
for coder / supervisor / no-folder, a supervisor's touch moving the coder's
folder and the coder's row reading it, files removed and restored read
through every session on the folder, idle and on-disk counts, work and push
through the folder, the list ordered and paged by the folder's touch,
expired-vs-live holds through `listIdleSince`, `expiredHold`, `acquireLock`
(warning logged) and the refusal of a live hold. Live over HTTP (36): a
real clone; the assistant row returned whole; `git/status` AS the assistant
opening the coder's folder and the touch landing on the coder; `follow` to
nothing then `no_folder`; the tool gate's 404 / 404 / 410; a supervisor
reading its coder's facts; an expired hold read as free, the feed's first
record carrying `died_on`, the takeover succeeding and carrying it once, a
release carrying none; destroy → every session on the folder reads
destroyed; restart; workspace delete refused while files exist and allowed
with only conversations left; a duplicate of a destroyed source whose
branch never reached origin refused `source_branch_gone` (the checkout's
own refusal through the route). Not exercised live: a container start
(`ensure(folderId)`) and the name-based running list — no workspace image
on this box; compile-checked.

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
