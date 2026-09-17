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
| 4 | `presets` | `Presets` (presets.ts) | |
| 5 | `commands` | `Commands` (commands.ts) | |
| 6 | `token_usage` | `TokenUsage` (tokenUsage.ts) | |
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
