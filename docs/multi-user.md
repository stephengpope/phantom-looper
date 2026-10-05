# Multi-user: database roles, mail, sign-in

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

## Not in this plan

- Media (database-backed files): its own plan, after this.
- The SDK's own routes fenced per user or organization; per-organization
  settings: user space's rules today; an SDK addition if an app needs
  them in the SDK.
- Row-level security: the addition the day an agent gets SQL on the SDK's
  tables.
- Password, OAuth, 2FA: Better Auth plugins, added when asked.
- The invitation and sign-in mails' wording as the app's own (a door for
  the app's templates).
