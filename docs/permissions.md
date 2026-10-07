# Permissions: organizations and users, top to bottom

Built 2026-10-07 (SDK migration 059). This supersedes `multi-user.md` where
the two differ: the SDK's own `/api` routes now take users, and the
row-level policies are the one rule.

## The rule

1. Every owned row records its **organization** and the **user** who made it.
2. A request works out who it is for, once, at the front of the API: a
   user (sign-in token or user API key) in their active organization, or
   the server key acting for someone (`x-phantom-organization`,
   `x-phantom-user`), or the server key alone.
3. Work for someone runs as Postgres's `authenticated` role with their
   organization and user set. The database only shows and changes that
   organization's rows. Nothing else checks anything.
4. The server key alone runs as `backend` and sees everything: the CLI, the
   looper, cron, git sync.
5. Settings use the same chain: **fixed → global → organization → user →
   project**. The most specific value wins, and fixed always wins.

## Credentials

| Credential | Header | Runs as |
|---|---|---|
| Server key (`API_KEY`) | `Authorization: Bearer` | `backend`: everything |
| Server key + `x-phantom-organization` (+ `x-phantom-user`, a member) | as above | that organization and user, under the policies |
| User sign-in token | `Authorization: Bearer` | that user, in the session's active organization |
| User API key | `x-api-key` | that user, in the organization the key was made for |

A user who is not a member of the organization gets no caller (401). This
is checked on every request, so a removed member loses access at once. The
client SDK's `BackendOptions.actingFor` sends the two headers.

## How it runs

- **`lib/acting.ts`**: `actAs({ organizationId, userId }, work)`, an
  AsyncLocalStorage. The front step in `HttpApi` (on `/api` and `/app`)
  wraps the rest of every request in it.
- **`Database.drizzle`**: the backend's pool, switched per statement when
  something is acting. Each statement runs in its own short transaction
  (`set_config('role', 'authenticated')` plus the two settings), and a
  drizzle transaction is switched right after its `BEGIN`. No connection is
  held between statements. Outside `actAs`, it is the pool as before. Every
  table owner uses this one handle, unchanged.
- **`Database.system`**: always `backend`. Two places use it:
  - **Better Auth**: it manages identity itself. On the acting handle,
    creating a user fails with "permission denied for table user", which
    was proven.
  - **The settings cascade's reads**: the global layer is no
    organization's row. Settings *writes* go through the acting handle, so
    the policies decide which layers a user may write.
- **One refusal.** A user gets `403 {code: access_denied, message: "access
  denied"}` for anything missing, forbidden or refused by a policy. It is
  shaped in `HttpApi` (an onSend hook and the error handler), and is the
  same whether the thing exists or not. A user's 500 says "internal error";
  the server key gets the detail.
- **Operator-only routes** (`config: { operator: true }`): presets, the
  test mail, user bootstrap, the media bucket's CORS, and Telegram notify.
  A user gets access denied. phantom-looper's `/app` routes admit the
  server key alone.
- **The two server-wide live feeds** (`/sessions/events`,
  `/settings/events`) are in-memory. Each event goes to a user only if a
  read as them can see the row it is about.

## Tables (migration 059)

- **Top-level** (projects, media, token_usage): `organization_id`
  defaults to the caller's, else `'operator'`. The operator's organization
  is a real row, so there are no null owners.
- **Under a parent** (workspaces, sessions, cards, crons under a project;
  card_revisions under a card; background_tasks under a session): a
  trigger copies the parent's organization, read as the caller. A parent
  the caller cannot see is refused (`insufficient_privilege`, which is
  access denied), never re-homed. A composite foreign key (`parent_id,
  organization_id`) makes drift impossible.
- **`user_id`** on every owned table, defaulting to the caller (null =
  the operator).
- **token_usage** (was `log_tokens`): a trigger stamps the session's
  organization and project. A session the caller cannot see is refused.
- **One policy shape**, on all ten owned tables:
  `organization_id = (select caller_organization())`, both `using` and
  `with check`. Settings: the caller's organization rows, the caller's own
  rows, and the rows of projects they can see. Settings carry generated
  `organization_id` / `user_id` / `project_id` columns from their scope.
- **Grants to `authenticated` are explicit.** It gets read only on
  `identity.user` / `organization` / `member`, and the ten owned tables.
  Nothing on presets, telegram_*, the ledgers, Better Auth's internals, or
  any app table unless the app's migration grants it.

## Roles

| Role | Owns / does |
|---|---|
| `migrator` | the SDK's schemas (`phantom_agent_sdk`, `identity`). The SDK's migrations run as it. |
| `app_migrator` | user space's schemas. The app's migrations run as it. It can read and reference SDK tables (joins, foreign keys, policies that join them) and cannot alter them: "must be owner". |
| `backend` | the process. Bypasses RLS, may become `authenticated`. |
| `authenticated` | a user. Policies decide every row. |

## Settings

- **Fixed:** `PhantomBackendConfig.fixedSettings`, values by key. They win
  everywhere, report `source: 'fixed'`, and any write is a 403. An unknown
  key or a bad value fails the boot. The app reads them from a file or the
  environment; the SDK takes values, not a format.
- **BYOK:** every provider key, plus Deepgram, Firecrawl and GitHub, can be
  set at the organization, user and project layers. Agents resolve keys for
  the user they run for (`scopeOf` adds the acting user).
- **Server-only:** `container_image` and `container_docker`. A value only
  counts at a layer its key allows, so old per-project rows are inert.
- **What a user sees:** a user names only their own organization and user,
  and a project they can see. Their settings list omits keys settable only
  globally (limits, SMTP, the console). Members can read their
  organization's keys.
- **`agent_media`** (off by default): the media tools and the media
  system-prompt block, where storage is configured.

## Also

- **Crons belong to the server SDK:** the table, the tools and the
  scheduler. The app hands it the agent a prompt cron runs
  (`PhantomBackendConfig.crons.agent`). Each run acts for the cron's owner
  (its project's organization and the user who made it), so the owner's
  keys come first.
- **Who did what is a user id the database stamps.** That covers
  `user_id` everywhere, plus `sessions.last_turn_user_id` (060).
  `started_by` / `last_turn_by` say only what kind of driver it was (a
  person, or an automation's name). A user's own request is always a
  person; only the server key names an automation.
- **Deleting a user** follows GitHub's rule. It is refused while their
  personal organization owns projects or files, or while they are the
  only owner of a shared organization. Once they go, their personal
  organization and both settings layers go with them.
- **Headers:** `x-phantom-client`, `x-phantom-session`, `x-phantom-actor`
  (were `x-phantom-looper-*`).
- **`container_docker` is off by default.** A privileged container can
  reach the host. Turn it on only on a server whose agents are all yours.
- **Pre-cloned checkouts** are keyed by project, never shared across
  organizations by repo name.
- **The git auto-push and auto-pull tools** stay inside the session's
  organization.
- **phantom-looper's 001/002** no longer alter SDK tables. SDK 059 drops
  those columns, and the leftover empty `phantom_looper` schema that a
  fresh install made.

## Proven

- Throwaway Postgres, with the real migrations and a copy of the real
  local data. Fresh install, upgrade, and a second boot.
- The real backend over HTTP: 50 scenario checks. Covered:
  - isolation, the one refusal, and the BYOK cascade
  - acting-for, user API keys, and operator-only routes
  - token usage stamping and the live feed
  - removed members
  - cron ownership and the person-only actor rule
  - the three user-deletion cases
- Fixed settings, against the real Settings code.

## Not yet

- Telegram: one bot per server. Per user (user id ↔ chat id) is next.
- Docker for agents on a shared server needs a safe runtime (Sysbox,
  rootless) before `container_docker` can be offered to organizations.
