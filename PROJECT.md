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
| 2 | `folders` | `Folders` (folders.ts) | |
| 3 | `loops` | `Loops` (loops.ts) | |
| 4 | `presets` | `Presets` (presets.ts) | |
| 5 | `commands` | `Commands` (commands.ts) | |
| 6 | `token_usage` | `TokenUsage` (tokenUsage.ts) | |
| 7 | `telegram_update` | `TelegramStore` (telegram/store.ts) | |
| 8 | `telegram_sent` | `TelegramStore` (telegram/store.ts) | |
| 9 | `telegram_account` | `TelegramStore` (telegram/store.ts) | |
| 10 | `workspaces` | `Workspaces` (workspaces.ts) | |
| 11 | `card_revisions` | `Cards` (cards.ts) | moved + renamed in #1; review still owed |
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

## Insights from table 1

- **Step 1 is not a grep count.** The first pass reported "queries are
  contained" from counting hits. The real leak (a route running DDL) was
  only visible after reading each hit. Report file:line, or do not report.
- **Step 2 can change the whole job.** This table could not be "protected";
  it could only be deleted, and deleting it meant fixing `cards`. Know which
  kind of table you have before proposing anything.
- **Seed the old shape, not the new one.** The migration test seeded two
  workspaces with colliding ids, a deleted card and a moved card. That is
  what found the trigger bug; reading the code never would have.
- **Rename before the behavior review, not after.** Parking the rename as a
  "raised item" was step 8 skipped. The builder caught it. Do it in the pass.
- **Words mean what they say.** "Create a cards table" when one exists is
  wrong; "move the cards into one table" is right. Sloppy words cost trust.
- **Prove over HTTP too.** Object tests passed; the route walk found my own
  helper sending `content-type: json` on a bodiless DELETE. Not a product
  bug, but the live layer is the only one that catches the live layer.
- **Test scaffolding lives outside the repo** (`/workspace/scratch/`), and
  `tsx` needs the scripts inside the repo tree to resolve `node_modules` —
  copy them into a gitignored `scratch-tmp/` for the run, move them out
  after.

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
