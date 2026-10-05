# Multi-user: mail, sign-in, ownership, invites

Designed 2026-10-05, not started. All of it is the SDK's — any app on it has
people and needs to reach them; phantom-looper turns it on. The rules of
`docs/v1-plan.md` stand for every step here.

## Why this shape

- **Invite-only, no open registration.** A team tool: the owner invites.
  Removes sign-up, abuse handling and a captcha.
- **Magic links, no passwords.** Clicking the emailed link IS verification,
  so there is no separate verify flow and no password reset flow. Standard
  for developer tools (Vercel, Linear, Notion offer it); on a single-team
  server it can be the only method.
- **Tokens, not sessions.** A sign-in hands the client an opaque bearer
  token (hashed at rest), stored where the cli stores the API key today.
- **Everything that acts is a user.** People are users with an email; the
  looper, cron and Telegram are users with `role: system` and their own
  tokens. One identity model, one column for "who".
- **Privacy ships with users.** Two people on one server must not see each
  other's conversations (and the secrets inside them) from the first day.

## 1. Mail

**Library: nodemailer.** Checked 2026-10-05: v10, released that week; ~17M
weekly downloads (Snyk: "key ecosystem project"); zero dependencies; MIT;
15 years old. It speaks SMTP, so the server's owner brings any provider
(Gmail, Fastmail, SES SMTP, Postmark SMTP) and nothing in the SDK names
one. The alternatives — Resend (~300K/week), SendGrid, Brevo — are vendor
SDKs: they bind the server to one company and its API key. For a
self-hosted box, nodemailer is the standard and nothing else is close.

- `Mailer` (SDK, one object): `send({ to, subject, text, html? })`; a
  failure is the provider's words.
- Settings (the same mechanism as every other; the password is a
  credential): `smtp_host`, `smtp_port`, `smtp_secure`, `smtp_user`,
  `smtp_password`, `smtp_from`. Links in mail are built from the address
  the server already knows (`PHANTOM_BACKEND_ADDRESS`).
- `POST /mail/test` (owner) — sends to the caller; proves SMTP before
  anyone is invited.
- An `email` notification channel beside Telegram, for free: "email me
  when a card blocks".

Useful on its own; ships first.

## 2. Users and sign-in

Tables (`phantom_agent_sdk`):

- `users` — id, email (unique, null for system users), name, role
  (`owner` | `member` | `system`), created_at.
- `user_tokens` — id, user_id, token_hash, label (a hostname, an app name),
  created_at, last_used_at.
- `login_links` — token_hash, user_id, expires_at (15 min), used_at (single
  use).

Routes (under `/api`, the same envelope):

| Route | Body → answer | Note |
|---|---|---|
| `POST /auth/login` | `{email}` → 202, always | no account enumeration; emails a link |
| `POST /auth/login/:token` | → `{token, user}` | consumes the link, mints a device token |
| `GET /auth/me` | → `user` | who am I |
| `GET /auth/tokens` · `DELETE /auth/tokens/:id` | | my devices; sign one out |

The bearer token identifies every request. `API_KEY` is retired to one job:
bootstrapping the first owner (the installer asks for an email, or
`phantom-backend invite <email>` on the host prints the first link — no
mail needed). The looper, cron and Telegram each get a system user and a
token minted at boot; the header `x-phantom-looper-actor` is deleted — the
token says who.

## 3. Who owns what

`sessions.started_by` and `sessions.last_turn_by` become references to
`users.id` — the same two columns, the same meaning (who opened it, who
drove it last), now a real who. Everything that reads them today (the
background filter, the Telegram starter, the Assistant's "newest
conversation of this person") compares ids instead of words.

The privacy rule, enforced in one guard per object (`Sessions.visibleTo`,
an owner gate on the settings routes):

| Thing | Who sees it | Who changes it |
|---|---|---|
| A session you opened | you (+ owners) | you |
| System sessions (looper, cron card runs) | every member — the team's work on shared cards | owners |
| Projects, boards, cards | every member | every member |
| Project settings | every member reads | owners |
| Global settings, provider keys, secrets, SMTP, users, invites | owners only | owners only |
| Telegram | bound to one user (the chat's): that user's sessions, nobody else's | that user |

Tools run as the session's user — a tool cannot reach a session its user
cannot see. Sharing a session with a teammate and per-project membership
are additions to this rule later; the rule does not change to take them.

## 4. Invites and the team

- `invites` — id, email, role, invited_by, token_hash, expires_at,
  accepted_at.

| Route | Body → answer | Note |
|---|---|---|
| `POST /invites` | `{email, role}` → 201 (owner) | emails the link |
| `GET /invites` · `DELETE /invites/:id` | (owner) | pending; revoke |
| `POST /invites/:token/accept` | `{name}` → `{token, user}` | creates the user, verified by the click, signed in |
| `GET /users` · `PATCH /users/:id` `{name, role}` · `DELETE /users/:id` | (owner) | the team |

Ten routes in all.

## The app's side

- cli `/server`: "sign in with email" beside "paste a key" (the key path
  stays for the system and dev case). `/resume` shows yours; owners get a
  switch for everyone's, like `[s]` for background today.
- Nothing else in the cli changes.

## Order

1 → 2 → 3 → 4. 3 cannot ship without 2; 4 cannot ship without 1. Each step
its own commits, proven on the live stack with real mail (a test SMTP
account) and two signed-in users.
