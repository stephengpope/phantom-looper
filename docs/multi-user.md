# Multi-user: database roles, mail, sign-in — and what is left

Designed and built 2026-10-05 (three commits: roles, mail, sign-in — each
proven on the live compose stack). All of it is the SDK's; an app turns
sign-in on. Media (database-backed files) is a later plan and is not in
this one.

## The model

The SDK is **auth as a service** (the Supabase shape): it ships the user
and organization tables, the sign-in routes and `backend.identity.require`.
Who may see which project, session or row is **user space's** rule, written
in user space's routes against user space's tables — which join the SDK's
tables in the same database. The SDK's own routes, the operator's
`API_KEY`, the looper, cron, Telegram and the cli do not change.

## Where things live

```
Postgres server
├── database phantom
│   ├── schema phantom_agent_sdk   the SDK's tables (+ its migration ledger)
│   ├── schema identity            Better Auth's: user, session, account, verification,
│   │                              organization, member, invitation, apikey (055)
│   ├── schema <app>               user space's tables (phantom_looper today)
│   │                              — joins the SDK's and identity's freely
│   └── schema public              empty
└── databases project_<id>         agent play spaces: separate, no joins (unchanged)
```

Identity's tables take their own schema because Better Auth's `session` (a
sign-in) beside the SDK's `sessions` (a conversation) in one schema would
read as one thing.

## Who connects to Postgres — the roles

One role per job, least privilege; a name says the job, no brand in it
(`storage/Database.ts`):

| Role | May | May not | Used by |
|---|---|---|---|
| `superuser` | everything | — | Docker's bootstrap (`POSTGRES_USER`; `phantom` on installs from before); boot, once; the database console |
| `migrator` | create / alter / drop tables in every schema of ours (owns them) | — | boot: `Database.migrate`, both sets, each on its own short-lived connection |
| `backend` | read / write rows in every schema of ours; create and drop play-space databases and roles | alter or drop a table | the running backend — SDK code and user space code, one process, one pool |
| `project_<id>` | everything inside its own database, tables included | anything outside it | the agent's `database_query` (unchanged) |

At runtime nothing — a bug, a bad query, a tool — can change a table. Only
the migration step can, once, at boot.

The two passwords are derived from `ENCRYPTION_KEY` (`lib/crypto
derivedPassword`), the way every play-space role's already was: stored
nowhere, re-set on every boot, never leaving the process. So there is no
new environment variable: `DATABASE_URL` is the superuser's, boot uses it
once (`Database.open`) to make sure the roles exist with current passwords
and grants, then hangs up and opens the pool as `backend`. An install from
before the split: that same boot hands every schema, table and function
to `migrator`, every `project_<id>` database to `backend` and gives
`backend` admin on their roles.

The console (CloudBeaver at `/db`) connects as the superuser (`DB_UI_DSN`)
and sees everything. Its own account — the browser prompt's name with the
API key — is `console_admin` (was `phantom_admin`: the admin account of
the console, nothing else in the name).

## Who calls the HTTP API — the paths

| Prefix | Owned by | Auth | Audience |
|---|---|---|---|
| `/api/*` | SDK | `API_KEY` (unchanged) | the operator: cli, looper, cron, updater, scripts; user space's own code |
| `/api/auth/*` | SDK (Better Auth) | public / the user's own token | an app's end users: sign in, organizations, invitations, keys |
| `/api/identity/*` | SDK | `me`: any caller · the rest: the key | who am I; the operator's bootstrap |
| `/app/*` | user space | the app's choice per route: `backend.identity.require` | the app's end users |
| `/db` | SDK (console) | Basic: `console_admin` + the API key | the operator, in a browser |

The SDK never serves under `/app`; user space never under `/api`. The
prefix says who owns a route and who may call it. `config.routes` registers
under `/app` with no key check — the app applies its own. A browser app on
another origin (`identity.trustedOrigins`) gets CORS with credentials on
`/api/auth` and `/app`. phantom-looper's routes (`/models`, `/update`,
`/system/*`) moved to `/app` and admit the operator alone, as before; the
client SDK sends a path under `/app/` to the origin, any other under
`/api`.

## Who sees what

| Caller | Sees |
|---|---|
| Operator (`API_KEY`) | everything |
| User space code (in-process) | every row; applies its own rules per end user |
| End user (Better Auth token) | what the app's `/app` routes hand them |
| Agent | its session's project; its own play-space database |
| Console | everything |

## 1. Mail

**Library: nodemailer** 10.0.15 (checked 2026-10-05: released that week;
~17M weekly downloads; zero dependencies; MIT; 15 years old). SMTP, so the
server's owner brings any provider and the SDK names none.

- `Mailer` (`backend.mailer`): `send({ to, subject, text, html? })`;
  `configured()`. The settings — `smtp_host`, `smtp_port`, `smtp_secure`,
  `smtp_user`, `smtp_password` (a credential), `smtp_from`, group `mail` —
  are read on every send, so a change applies with no restart. A failure
  is the provider's words (`MailerError` `not_configured` | `send_failed`).
- `POST /api/mail/test {to}` — proves SMTP before anyone is invited.

## 2. Sign-in

**Library: Better Auth** 1.7.7 (checked 2026-10-05: released 2026-09-30,
30k stars, pushed daily). drizzle-orm went 0.38.4 → 0.45.3 for its adapter
(release notes 0.39 → 0.45.3 list no breaking change).

**Tables** (055, schema `identity`): Better Auth's generated SQL in this
ledger's style; the Drizzle mirror in `storage/schema.ts` beside every
other SDK table.

- Core: `user`, `session`, `account`, `verification`.
- `organization` plugin: `organization`, `member` (role `owner` | `admin`
  | `member`), `invitation`. Every user gets a personal organization the
  moment they exist; a sign-in opens in their first organization when the
  session names none; an invitation adds membership in another.
- `magicLink` plugin, invite-only (`disableSignUp`): the emailed link is the
  sign-in and the verification; a stranger's email gets no mail and no
  account (the route still answers 200). An invitee without an account
  gets one when invited, so the link works.
- `bearer`: the session token as `Authorization: Bearer` for a cli or a
  script (`set-auth-token` on sign-in). `admin`: `role`, `banned`; list /
  ban / set role. `apiKey`: `x-api-key`, a long-lived key resolving to its
  user. `openAPI`: `/api/auth/reference`.

**Config door** (`PhantomBackendConfig.identity`; absent = off: no
`/api/auth` route, nothing written):

```ts
identity: {
  secret: env.AUTH_SECRET,                      // 32+ characters
  trustedOrigins: ['https://app.example'],      // browser apps on another origin
  invitationUrl: (id) => `https://app.example/invitations/${id}`,   // the app's page; unset: the mail carries the id
}
```

phantom-looper turns it on when `AUTH_SECRET` is set (`AUTH_TRUSTED_ORIGINS`
comma-separated); nothing in it uses it yet.

**Bootstrap:** the operator makes the first user with
`POST /api/identity/users {email, name}` and gets their link with
`POST /api/identity/magic-link {email}` — handed back, not mailed, so
SMTP is not needed for the first sign-in. From there users invite others
(`/api/auth/organization/invite-member`, mailed).

## The objects

```ts
// src/mail/Mailer.ts — backend.mailer
class Mailer {
  constructor(settings: Settings)
  configured(): Promise<boolean>
  send(mail: Mail): Promise<void>
}
class MailerError extends Error { code: 'not_configured' | 'send_failed' }

// src/identity/Identity.ts — backend.identity; the one owner of Better Auth
class Identity {
  constructor(database: Database, mailer: Mailer, options: IdentityOptions | undefined, baseUrl: string, apiKey: string)
  readonly enabled: boolean
  readonly trustedOrigins: readonly string[]
  handler(request, reply): Promise<void>                       // Better Auth at /api/auth/*
  callerOf(request): Promise<Caller | null>                    // key, cookie, bearer or api key → who; null = nobody
  require(request, options?: { users?: boolean }): Promise<Caller>   // IdentityError 'unauthorized' → 401
  createUser({ email, name? }): Promise<UserRow>               // bootstrap; 'email_taken' → 409
  magicLink(email): Promise<string>                            // bootstrap: the link, not mailed
}
type Caller = { kind: 'operator' } | { kind: 'user'; user: UserRow; organization: OrganizationRow; role: OrganizationRole }
class IdentityError extends Error { code: 'disabled' | 'unauthorized' | 'email_taken' }

// src/storage/Database.ts
Database.open(superuserUrl, encryptionKey): Promise<Database>   // the roles, then the pool as backend
database.url                                                     // the backend role's connection string
database.migrate(set): Promise<string[]>                         // as migrator, own connection

// src/api/HttpApi.ts — /api (key; a route marked config.caller decides itself), /api/auth, /app
```

Exported: `Mailer`, `MailerError`, `Identity`,
`IdentityError`, `IDENTITY_PATH`, `type Caller`, `type IdentityOptions`,
`type OrganizationRole`, `type UserRow` … `type ApiKeyRow`.

## Proven on the live stack (compose, api rebuilt, Mailpit on the network)

- Roles: a database migrated under the old code with a play space, opened
  by the new boot — every table to migrator, backend inserts a row,
  `alter table` / `drop table` refused ("must be owner"), play spaces
  created, queried, dropped; a fresh database the same. The console opens
  as `console_admin` and connects.
- Mail: `mail_not_configured`; the six settings over the API; the test
  mail in the inbox.
- Sign-in: the operator creates Ann (409 the second time); her link
  handed back signs her in (bearer, `me` → her personal organization,
  owner); her link by mail does the same; a stranger's request gets 200
  and no mail; Ann makes Acme and invites Bob — the mail arrives, Bob's
  user exists, he signs in, accepts, sets Acme active, `me` → Acme,
  member; Bob's API key answers `me`; a garbage token is 401; Ann's token
  on `/api/projects` is 401; sign-out ends her session. CORS: a trusted
  origin's preflight is allowed with credentials, an unknown origin's is
  not. Off (`AUTH_SECRET` empty): `/api/auth` is a bare 401, `me` still
  answers the operator, the bootstrap route answers `disabled`, `/app`
  answers the key.

## Part 2 — built 2026-10-05

Six steps, each its own commit. Step 3 was proven on the live stack
(the chain, the refusals, the 404, the cli's view); 4–8 typecheck across
the SDK, the app and the cli and were not run live — the proofs listed
under each are what to run. What was built differs from the plan where
noted.

### 3. Settings per organization and per user

**What.** The chain `global → organization → user → project`. A shared
provider key lives at the organization; a member's own at their user row;
the project's fact wins last. Today's chain is `global → project`,
hardcoded in six places of `storage/Settings.ts` (`scopesFor`,
`rawLayers`, `computeLayers`, `layersOf`, `writeAtScope`, the two
credential readers).

**Trace.** A session in project P of organization O: `AgentConfig.resolve`
→ `settings.credential('anthropic_api_key', scope)` → `scopesFor(scope)`
→ `[global, organization:O, user:U?, project:P]` → the most specific row
wins. Every read site passes `{ projectId: project.id }` with the project
row in hand (27 sites) or a scope handed down from one (AgentConfig,
SystemPrompt, oneShot); none has the organization. So the scope carries
it: `scopeOf(project)` — one helper beside `SettingScope` — gives
`{ projectId, organizationId }` from the row's new column (step 4 adds
it; this step adds the column first, with no owner yet). `userId` is
never the SDK's to fill: the looper, cron, Telegram and the `/api` routes
run as the operator; user space passes `{ userId }` in its own calls.

**Changes.**

- `lib/scopes.ts`: `organizationScope(id)`, `userScope(id)`.
- `SettingScope { projectId?, organizationId?, userId? }`;
  `SettingSource` and `SettingLayers` gain `organization` and `user`;
  `scopeOf(project: ProjectRow)`.
- `SettingDefinition.overridableAt?: ('organization' | 'user' | 'project')[]`
  replaces `projectOverridable` (37 declarations: the SDK's, the app's,
  every agent type's ten; `projectOnly` stays). The rule applied to the
  SDK's own: whatever a project may override, an organization and a user
  may too — a bigger project; operator-only settings (console, telegram,
  smtp, limits, upgrade) stay global.
- `Settings.writeAtScope(layer, scopeName, patch)`: `layer` is the chain's
  word; `not_overridable` says which layer refused. The provider-first
  rule applies at every layer below global.
- `GET /settings?organization=&user=&project=` answers the layers
  `organization` and `user` beside `global` and `project`; `PATCH` and
  `DELETE` take the same query. `?organization=` names a row in
  `identity.organization`, `?user=` in `identity.user` — 404 otherwise,
  the same rule as `?project=`. The cli reads `global`/`project` and
  nothing changes on its screens.
- Secrets (`listSecrets`, `readSecret`, the `/secrets` routes'
  `scopes.chain`): the same chain.
- A deleted organization or user takes its layer with it:
  `organizationHooks.afterDeleteOrganization` and
  `databaseHooks.user.delete.after` → `settings.deleteScope`.

**Proof.** The key set at `?organization=O` resolves in O's project and not
in a project with no organization; `?user=U` + `{ userId: U }` wins over
O's; the project's own wins over both; `not_overridable` names the layer;
the cli's settings screen is unchanged; deleting O deletes its rows.

### 4. Ownership in the SDK's data

*Built:* the column and constraint came with 056 in step 3;
`Projects.list(caller?)` / `get(id, caller?)` and `NewProject.organizationId`.

**What.** `projects.organization_id` (nullable → the operator's, which is
every project today; FK to `identity.organization`, `on delete set null`
— a deleted organization's projects become the operator's, never
vanish). `unique nulls not distinct (organization_id, owner, name)`
replaces `unique (owner, name)`: two organizations may register one repo.

**Trace.** User space's `/app` route: `caller = identity.require(req,
{ users: true })` → `projects.list(caller)` / `projects.get(id, caller)`
→ `visibleTo(caller)`: the operator matches every row; a user matches
`organization_id = caller.organization.id`. Everything under a project —
workspaces, sessions, cards, crons, the play-space database, secrets,
project settings — is reached through a `ProjectRow` (Cards, Crons,
Sessions.create, the tools' `ToolCtx.project`) or a `projectId` taken
from one, so a project the guard refused takes all of it with it: one
check, inherited. `projects.create({ …, organizationId })` from user
space; the SDK's `POST /api/projects` (operator) writes null.
`Sessions.list({ project })` is already per project. The SDK's own `/api`
routes stay operator-only and unfiltered — the operator sees everything.

**Changes.** Migration 056 (the column, the FK, the constraint);
`ProjectRow.organizationId`; `Projects.list(caller?)`, `get(id, caller?)`,
`create(row & { organizationId? })`; `Caller` accepted by the two.
`scopeOf(project)` (step 3) now carries the organization.

**Proof.** User A's project is 404 to user B through an `/app` route and
listed to the operator; a tool in A's session cannot name B's project;
the same repo registered by both organizations; deleting A's organization
leaves the project, owner null.

### 5. Row-level security

*Built:* `Database.queryAs(caller, sql, options)`, the `authenticated` role
(`backend` carries BYPASSRLS — policies bind every role but the owner and
BYPASSRLS roles, so the SDK's own reads and writes are untouched),
`storage/sqlRunner.ts` shared with AgentDatabases, migration 057. The
settings are `phantom.organization_id` / `phantom.user_id`
(`ORGANIZATION_SETTING`, `USER_SETTING`).

**What.** The same fence enforced by Postgres, for the day SQL on the SDK's
tables is handed to something that is not the backend's own code: an
agent's tool, a user-space route that lets a user query. Without a
consumer it is dead code, so this step ships the consumer with it:
`backend.database.queryAs(caller, sql, options)`.

**Trace.** A fifth role, `authenticated`: login, no ownership, `select /
insert / update / delete` on the SDK's and the app's tables through
policies only (`ensureRoles` creates it; default privileges from
`migrator` grant it the same row access as `backend`). `queryAs` opens one
connection as it, `begin; select set_config('phantom.organization_id', $1,
true); set_config('phantom.user_id', $2, true)`, runs the caller's
statements with the runner `AgentDatabases.query` already has (lifted
into `storage/sqlRunner.ts`, used by both), commits. Policies (migration
057), one per table, keyed on the organization:

| Table | Policy |
|---|---|
| `projects` | `organization_id = current_setting('phantom.organization_id')` |
| `workspaces`, `cards`, `card_revisions`, `crons`, `sessions` | its project is visible (a `security definer` helper `phantom_agent_sdk.visible_project(id)` so the chain is one indexed lookup, not a nested policy) |
| `identity.organization`, `identity.member` | the caller's own |
| `identity.user` | self |
| `settings`, `presets`, `log_tokens`, `background_tasks`, `telegram_*`, `identity.session / account / verification / apikey / invitation` | no policy = no rows: credentials and tokens never cross |

The app's tables: the app's migrations write their policies (migrator
owns them); the SDK documents the setting names.

**Changes.** `ensureRoles` (+1 role); `Database.queryAs`;
`storage/sqlRunner.ts`; migration 057; no route — user space exposes it
how it wants (a tool it registers, an `/app` route).

**Proof.** As organization A, `select * from phantom_agent_sdk.projects`
returns A's rows only, `update … where id = <B's>` touches 0 rows,
`select * from phantom_agent_sdk.settings` returns nothing, `create
table` is refused; as the operator (`backend` role) everything is as
before.

### 6. Password and OAuth sign-in

*Built:* `IdentityOptions.signIn: { password?, github?, google? }`;
phantom-looper passes `AUTH_PASSWORD=1`, `AUTH_GITHUB_CLIENT_ID/SECRET`.

**What.** Beside magic links: email + password, and GitHub / Google.
Invite-only stays: nothing creates a user but the operator and an
invitation.

**Trace.** `identity.signIn: { password?: true; github?: { clientId,
clientSecret }; google?: { clientId, clientSecret } }`. Better Auth:
`emailAndPassword: { enabled, disableSignUp: true, requireEmailVerification:
true, sendResetPassword }`, `emailVerification: { sendVerificationEmail }`,
`socialProviders: { github: { …, disableSignUp: true } }`. An invited user
has no password: "set a password" IS the reset flow (`POST
/api/auth/request-password-reset` → mail → `/reset-password`). A social
sign-in links to the existing user by verified email (Better Auth's
`account` row); a stranger's GitHub login is refused. Secrets at
construction, from the app's config — not the settings table: Better
Auth takes them when built, and a setting read at boot is a restart to
change anyway. The client SDK (step 8) carries the three.

**Changes.** `IdentityOptions.signIn`; four `Mailer` sends (step 7's door
names them); `account` rows start being written.

**Proof.** The operator creates a user; they request a reset (mail), set a
password, sign in with it, `me` answers; a stranger's `sign-up/email` is
refused; a GitHub login for an invited email links and signs in (a test
OAuth app); one for a stranger is refused; unverified + password → refused
until the verification link is clicked.

### 7. Mail wording is user space's

*Built:* `IdentityOptions.mail: Partial<MailTemplates>` — a template answers
`MailBody` (the mail without its recipient); `invitationUrl` is gone, the
invitation template builds the app's link from `invitationId`.

**What.** The SDK sends four mails (sign-in link, invitation, password
reset, verification) with plain default wording. The app supplies its own
through one door; the SDK never knows the app's pages or voice.

```ts
identity: {
  mail?: {
    magicLink?:     (data: { email: string; url: string }) => Mail;
    invitation?:    (data: { email: string; organization: OrganizationRow; inviter: UserRow; role: string; invitationId: string; url?: string }) => Mail;
    passwordReset?: (data: { user: UserRow; url: string }) => Mail;
    verification?:  (data: { user: UserRow; url: string }) => Mail;
  };
}
```

`invitationUrl` folds into `invitation` (the app builds the link in its
own template). Absent, the SDK's default text; `Mail` is `Mailer.send`'s
shape, so a template is a pure function the app can test alone.

**Proof.** phantom-looper supplies one template; the mail carries it; the
other three are the defaults.

### 8. Client SDK

*Built:* `BackendOptions.credential` (`{ operatorKey } | { sessionToken } |
{ apiKey }`) replaces `apiKey`; `backend.identity.auth` (Better Auth's
client), `identity.me()`, `identity.verify(token)`.

**What.** An app on `@phantom-agent-sdk/client` signs in, reads who it is,
manages organizations and keys without hand-rolling calls. Better Auth
ships its client (`better-auth/client`, `createAuthClient` with
`magicLinkClient`, `organizationClient`, `adminClient`,
`apiKeyClient`): typed, every route, maintained with the server. The
wrapper is thin — the client SDK's `BackendClient` holds the credential
and the origin; Better Auth's client rides it.

```ts
const backend = new BackendClient({ url, credential: { operatorKey } | { sessionToken } | { apiKey } });
backend.identity.me()                               // GET /api/identity/me → Caller
backend.identity.auth                               // Better Auth's client: signIn.magicLink, magicLink.verify, signOut,
                                                    //   organization.*, apiKey.*, admin.*, signIn.email, signIn.social
backend.identity.verify(token)                      // the link's token → session token, stored on this client
```

`apiKey` on `BackendClient` becomes `credential`: three kinds, one header
each (`Authorization: Bearer` for the operator's key and a session token,
`x-api-key` for a Better Auth key). Paths under `/app/` go to the origin
(already); `/api/auth/*` is the Better Auth client's own base.

**Proof.** A script on the client SDK: `verify(link)` → `me()` → a user;
`auth.organization.create` → `me()` names it; `auth.apiKey.create` → a
second `BackendClient` on it → `me()`; the cli still connects with the
operator's key.

### Order and size

3 → 4 → 5 → 6 → 7 → 8. 4 needs 3's column and scope; 5 needs 4's
ownership to key on; 6 and 7 are independent of 3–5 but 7 names 6's two
mails; 8 last, over everything. Sizes: 3 is the big one (a core object
and 37 declarations); 4 small; 5 medium (roles, runner lift, policies, a
proof per table); 6 small-medium (Better Auth options, two flows); 7
small; 8 small-medium (the credential shape touches every BackendClient
construction: cli, looper, Telegram).

## Not in this plan

- Media (database-backed files): its own plan, after part 2.
- The SDK's own `/api` routes filtered per organization: they are the
  operator's; user space's `/app` routes are where a user's view is built
  (step 4's guard).
- 2FA, passkeys: Better Auth plugins, added when asked.
- Per-project membership inside an organization; sharing a session with a
  teammate: additions to step 4's guard, not changes to it.
