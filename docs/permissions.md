# Permissions: organizations and users, top to bottom

Built 2026-10-05–07 (SDK migrations 055–061). All of it is the SDK's; an app
turns sign-in on. phantom-looper turns it on when `AUTH_SECRET` is set and
uses none of it yet.

## Where things live

```
Postgres server
├── database phantom
│   ├── schema phantom_agent_sdk   the SDK's tables (+ its migration ledger)
│   ├── schema identity            Better Auth's: user, session, account, verification,
│   │                              organization, member, invitation, apikey
│   ├── schema <app>               user space's tables (phantom_looper)
│   └── schema public              empty
└── databases project_<id>         agent play spaces: separate, no joins
```

| Prefix | Owned by | Auth |
|---|---|---|
| `/api/*` | SDK | the service role key, a user role key or a sign-in token; a route flagged `serviceRole` refuses a user |
| `/api/auth/*` | SDK (Better Auth) | public / the user's own token: sign in, organizations, invitations, keys |
| `/api/identity/*` | SDK | `me`: any caller · the rest: the service role's bootstrap |
| `/app/*` | user space | the same credentials, identified and not refused; the route decides with `backend.identity.require` |
| `/db`, `/docs` | SDK (console) | Basic: `service_role` + the service role key |

## Sign-in and mail

- **Better Auth** (`identity/Identity.ts`, the one owner): plugins
  `organization` (every user gets a personal organization), `magicLink`
  (invite-only: a stranger's email gets 200 and no mail), `bearer`, `admin`,
  `apiKey`. Password sign-in and GitHub/Google are options
  (`IdentityOptions.signIn`); "set a password" is the reset flow, and
  completing it verifies the address.
- **Config door** `PhantomBackendConfig.identity: { secret, trustedOrigins,
  signIn?, mail? }`. Absent: no `/api/auth` route, nothing written. `mail`
  is four templates (magic link, invitation, password reset, verification);
  absent, the SDK's plain wording.
- **Bootstrap:** the service role makes the first user with
  `POST /api/identity/users {email, name}` and gets their link from
  `POST /api/identity/magic-link {email}`, handed back, not mailed.
- **Mail** is nodemailer over SMTP (`backend.mailer`): settings `smtp_host`,
  `smtp_port`, `smtp_secure`, `smtp_user`, `smtp_password`, `smtp_from`, read
  on every send; `POST /api/mail/test {to}` proves it.
- **Client SDK:** `new BackendClient({ url, credential })` with
  `{ serviceRoleKey } | { sessionToken } | { userRoleKey }`;
  `backend.identity.me()`, `.verify(token)`, and Better Auth's own client at
  `backend.identity.auth`.

## The rule

1. Every owned row records its **organization** and the **user** who made it.
2. A request works out who it is for, once, at the front of the API: a
   user (sign-in token or user API key) in their active organization, or
   the service role acting for someone (`x-phantom-organization`,
   `x-phantom-user`), or the service role alone.
3. Work for someone runs as Postgres's `authenticated` role with their
   organization and user set. The database only shows and changes that
   organization's rows. Nothing else checks anything.
4. The service role alone runs as `service_role` and sees everything: the CLI, the
   looper, cron, git sync.
5. Settings use the same chain: **fixed → global → organization → user →
   project**. The most specific value wins, and fixed always wins.

## Credentials

| Credential | Header | Runs as |
|---|---|---|
| Service role key (`SERVICE_ROLE_KEY`, `ph_service_role_…`) | `Authorization: Bearer` | `service_role`: everything |
| Service role key + `x-phantom-organization` (+ `x-phantom-user`, a member) | as above | that organization and user, under the policies |
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
- **`Database.system`**: always `service_role`. Two places use it:
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
  the log gets the detail.
- **Service-role-only routes** (`config: { serviceRole: true }`): presets, the
  test mail, user bootstrap, the media bucket's CORS, Telegram notify, and
  the server's own operations (`/models`, `/update`, `/system/*`). A user
  gets access denied. phantom-looper registers no `/app` route.
- **The two server-wide live feeds** (`/sessions/events`,
  `/settings/events`) are in-memory. Each event goes to a user only if a
  read as them can see the row it is about.

## Tables (migration 059)

- **Top-level** (projects, media, token_usage): `organization_id`
  defaults to the caller's, else `'service_role'`. The service role's organization
  is a real row, so there are no null owners.
- **Under a parent** (workspaces, sessions, cards, crons under a project;
  card_revisions under a card; background_tasks under a session): a
  trigger copies the parent's organization, read as the caller. A parent
  the caller cannot see is refused (`insufficient_privilege`, which is
  access denied), never re-homed. A composite foreign key (`parent_id,
  organization_id`) makes drift impossible.
- **`user_id`** on every owned table, defaulting to the caller (null =
  the service role).
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
| `service_role` | the process (was `backend`; boot renames it). Bypasses RLS, may become `authenticated`. |
| `authenticated` | a user. Policies decide every row. |

## Settings

- **Fixed:** `PhantomBackendConfig.fixedSettings`, values by key. They win
  everywhere, report `source: 'fixed'`, and any write is a 403. An unknown
  key or a bad value fails the boot. The app reads them from a file or the
  environment; the SDK takes values, not a format.
- **Fixed by the deployment:** the app lists which settings a deployment
  may fix (`PhantomBackendConfig.envSettings`; phantom-looper's covers
  mail, Telegram, storage, containers, the server's switches and default
  keys). Each is read from its own name in capitals (`SMTP_HOST=…` fixes
  `smtp_host`) and, when set, is fixed exactly like a constructor value.
  It is optional; with none set, nothing changes. It is read at boot, so a
  change means a restart. A bad value, or a clash with the constructor,
  stops the boot with the reason. The API container reads `.env`
  (`env_file`, not required).
- **The server's own variables** are `BACKEND_*` (`BACKEND_ADDRESS`,
  `BACKEND_PORT`, `BACKEND_TLS`, `BACKEND_TAG`, …); they were
  `PHANTOM_BACKEND_*`. The updater (on start) and `install.sh` rename old
  lines in `.env` once. The compose file reads the old names for that one
  upgrade only.
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
  person; only the service role names an automation.
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

## Agent containers

Each agent reaches the internet and its own files, and nothing on the
server.

- **The agents' network** (`AGENT_NETWORK=phantom-agents`, made by the
  server SDK when missing). Inter-container traffic is off, so an agent
  cannot reach another agent, the API, Postgres or the Docker proxy.
  Containers made before it existed are recreated on it on next use. They
  are stateless, so that costs a restart.
- **Shared-database mode** (`agent_database_shared`) gives each workspace
  a private `internal` network holding only that container and Postgres
  (`AGENT_DATABASE_CONTAINER`), reached by the URL's host name. It is
  removed with the container, or when the mode is turned off.
- **The Docker proxy** sits on its own internal network with the API
  alone. `NETWORKS` is now allowed, for the two networks above. This keeps
  CVE-2026-78122 (the proxy's read endpoints, no fixed release yet) out of
  any agent's reach.
- **Cloud metadata** (`169.254.169.254`): `scripts/install.sh` installs a
  boot-time unit that drops agent traffic to it in `DOCKER-USER`.
- **Settings (server only):**
  - `container_pids_limit` defaults to 4096.
  - `container_docker` (privileged) defaults off.
  - `container_sudo` (default on). Off adds `no-new-privileges`, so the
    agent cannot become root.
  - `container_runtime` (unset = Docker's default; `runsc` = gVisor, once
    installed on the server).
- **Proven live on the local stack, with real agent containers:**
  - An agent reaches the internet. Another agent, the Docker proxy (by
    name and by IP), the API, Postgres, and the agents network's gateway
    on 8080, 5432, 2375 and 22 are all unreachable.
  - Shared mode reaches its own database and logs in as its own role,
    still nothing else. Turning it off removes the private network.
  - Sudo off is refused by the kernel.
  - The `DOCKER-USER` rule drops agent traffic only, tested on Docker's
    Linux VM with a stand-in address.
- **On a Mac, under Docker Desktop**, an agent can reach the Mac itself
  through `host.docker.internal`. That is Docker Desktop's own, for
  development. What answers there (the API) needs its key. A Linux server
  has no such path, and its gateway is closed as above.

## Agent disk limit

`container_disk_gb` (server only, unset = no cap) holds each agent to N GB
on two fronts. A write past it fails with "Disk quota exceeded"; the agent
is told its limit in its system prompt (`disk_limit`), frees space and
carries on.

- **Its container's own files:** Docker's `StorageOpt size`, applied at
  container creation.
- **Its checkout:** an XFS project quota on `work/<id>`, set by the
  `disk-quota` helper (`runtime/diskQuotaHelper.ts`, compose profile
  `disk-quota`) before the container starts. A limit that cannot be
  applied stops the container; it never runs unlimited.

The setting is refused unless the server can enforce both. The check runs
a 1 GB-capped probe container, which must see 1 GB, and the helper must
report project quotas enforced. A value already set that stops being
enforceable stops the server at boot, with the reason.

**Server setup (manual for now).** On DigitalOcean:

1. Attach a Volume and choose Manually Format & Mount.
2. As root:
   ```sh
   DEV=/dev/disk/by-id/scsi-0DO_Volume_<name>
   mkfs.xfs "$DEV" && mkdir -p /var/lib/docker
   echo "$DEV /var/lib/docker xfs defaults,nofail,discard,pquota 0 2" >> /etc/fstab
   mount -a
   ```
3. Use Docker's overlay2 driver, not the containerd image store. The
   containerd store accepts a size cap and silently ignores it, which was
   proven on Docker Desktop. In `/etc/docker/daemon.json`:
   ```json
   { "storage-driver": "overlay2", "features": { "containerd-snapshotter": false } }
   ```
4. Install. Then add `disk-quota` to `COMPOSE_PROFILES` in `.env` and run
   `docker compose up -d`.
5. Check that `docker info` shows `Storage Driver: overlay2` and `Backing
   Filesystem: xfs`. Then set `container_disk_gb`: a server that cannot
   enforce it answers why.

Proven on a Linux runner (overlay2 on XFS with pquota):
- a 100M-capped container saw 100M and stopped a 200M write at 99M
- the helper capped a checkout at 1G and stopped a 1.2G write at exactly
  1.0G
- a path outside `work/` was refused

On Docker Desktop the setting is refused, because its 1 GB probe saw 1007
GB. Docker Desktop's kernel has no XFS quotas at all.

## Proven

- Throwaway Postgres, with the real migrations and a copy of the real
  local data. Fresh install, upgrade, and a second boot.
- The real backend over HTTP: 50 scenario checks. Covered:
  - isolation, the one refusal, and the BYOK cascade
  - acting-for, user role keys, and service-role-only routes
  - token usage stamping and the live feed
  - removed members
  - cron ownership and the person-only actor rule
  - the three user-deletion cases
- Fixed settings, against the real Settings code.

## Telegram, per user

One bot per server, and any number of linked chats. Each chat is its own
user's, in their organization, and everything said there runs as them, the
same way an API call does.

- **The service role's chat** is the `telegram_authorized_user` setting, the
  one the CLI sets. It sees the whole server, as before.
- **A user links a chat:**
  1. `POST /api/telegram/links` returns a one-time link valid for ten
     minutes. With `project`, the chat is that project's.
  2. The chat that sends it to the bot (`/start <code>`, or
     `/start@bot <code>` in a group) becomes theirs.
  3. The links are listed with `GET` and removed with `DELETE`, and a user
     reaches only their own.
- **Only the Telegram account that linked a chat** speaks in it. In a group,
  other members are ignored, and an unlinked chat gets no answer.
- **A private chat covers all of a user's projects** (switch with
  `/projects`). A project's group always points at its project.
- **Where messages go:** a session's message, alert or `send_message` goes
  to its owner's chat for that project, else to their private chat. The
  service role's own work goes to the service role's chat.
- **Server commands** (status, providers, models, presets, update, restart,
  tokens, cpu) answer "access denied" outside the service role's chat.
- **Tables:** `telegram_chats` and `telegram_link_codes` (061) carry the
  owner rule. The app's chat state is per chat
  (`phantom_looper.telegram_chat_state`, 003); the old single row moved to
  the service role's chat.
- **Self-hosted Bot API:** `TELEGRAM_API_BASE` points the bot at Telegram's
  own self-hosted Bot API server, or at a stand-in for tests.
- **Proven** on the real backend with Telegram faked: 23 checks covering
  linking, one-time codes, each chat seeing only its user's work, the
  service role's chat seeing all, server commands refused, a project group
  pinned to its project, other group members ignored, messages routed to
  their owner, managing links, and per-chat state. Migrations were checked
  on a copy of the real local data, which moved the state row to the
  service role's chat with its session and project, and on a fresh install.
