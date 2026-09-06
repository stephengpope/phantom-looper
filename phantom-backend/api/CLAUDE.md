# phantom-backend/api/ — the HTTP surface

```
app.ts               AppCtx (everything a route may need), ok/err envelope helpers, the bearer hook, error and
                     404 handlers, route registration order. forceCloseConnections so shutdown never waits on feeds
boardEvents.ts       BoardEvents: one in-process emitter per api, keyed by workspace. publish / subscribe / subscribeAll
sessionEvents.ts     SessionEvents: the same shape keyed by session, every event tagged with its publisher's client id.
                     capPart clips tool results to 16KB and marks them
routes/settings.ts   GET/PATCH /settings, DELETE /settings/:key (?workspace= / ?session= picks the layer)
routes/secrets.ts    GET /secrets, PUT/GET/DELETE /secrets/:name (the secret namespace, global + workspace layers)
routes/workspaces.ts GET/POST /workspaces, GET/PATCH/DELETE /workspaces/:id, GET /github/whoami, GET /github/repos
routes/sessions.ts   GET/POST /sessions, GET/PATCH/DELETE /sessions/:id, the lock, the transcript, the events feed and
                     relay, POST /sessions/:id/turn, duplicate, token-usage; the turn-start hook (preview + first-message title)
routes/fs.ts         GET /tools, POST /tools/<name>; runBash (unary with the pidfile kill; detached with an ND-JSON log)
routes/tasks.ts      GET /sessions/:id/tasks (ps inside the container, grouped by sid), DELETE /sessions/:id/tasks/:sid
routes/skills.ts     GET /skills, GET /skills/:name (?file=), POST /skills (writes go through the container)
routes/git.ts        POST /git/push, /git/pull, GET /git/status, POST /git/auto-push, /git/auto-pull (ND-JSON via streamRun),
                     GET /commands/:cmdId/logs
routes/kanban.ts     GET/POST /workspaces/:id/cards, PATCH/DELETE /workspaces/:id/cards/:cardId, GET /workspaces/:id/revisions,
                     GET /workspaces/:id/events; auto-push on archive
routes/web.ts        POST /web/search, POST /web/fetch (Firecrawl; pages land in work/<id>/web/)
routes/system.ts     GET /health, GET /models?provider=, POST /update
routes/telegram.ts   POST /telegram/webhook — the one route outside the bearer hook
```

## Conventions every route follows

- Bearer `API_KEY` on everything except the webhook. Every body is
  `{ok:true,data}` or `{ok:false,error:{code,message,retryable}}`, 404s
  and schema failures included, because the model reads the envelope.
- Session-scoped routes take `x-phantom-looper-session`. The lock identity
  is `x-phantom-looper-client`. Neither rides in a body.
- Fastify rejects a JSON content-type with no body. Send `{}`, and
  `looper/injectFetch.ts` drops the header when there is no body.
- Route `summary` and `description` are the API's in-source documentation.
  Nothing serves them any more; keep them current anyway.
- `ctx.looper` and `ctx.telegram` are set after listen, so routes read them
  per request and guard with `?.`.

## Sessions route, the parts that are not obvious

- POST /sessions returns the four frozen prompt inputs: `skills` (repo
  tier scanned after checkout, merged with the image's system tier),
  `secrets` (names and descriptions), `environment`, `agent_git_credentials`.
- GET /sessions decides what the list is. `typed`, `supervisor` and the
  keyset cursor share one WHERE, so `total` matches the pages. `git=true`
  reads each checkout for `work`, so ask only when a screen shows it.
- The transcript PUT does four things in one UPDATE: stores the blob,
  moves the preview, bumps `turn_count`, re-derives `agent`. Then it
  renews the holder's lock, publishes the `transcript` event, and may fire
  the titler.
- The token-usage cache is valid only while `tokens_as_of` equals
  `transcript_updated_at`; a save moves the stamp, so a stale cache cannot
  exist.
- The turn route is a view of the session feed: it subscribes, runs
  `runCodingTurn`, and maps parts to its own lines. Parts are published in
  one place.

## The two feeds

The board feed streams every card write plus `{event:'session'}` when a
loop pairs a card. `from` is the status before an update and `client` is
the writer; `telegram/alerts.ts` reads both. No replay; clients load on
connect.

The session feed streams turn-start, every AI SDK part, turn-end, error,
the `transcript` save, lock state (connect, take, renew, release), and
`session` state changes (agent, planMode, work). Every connect sends a state
snapshot including transcript_updated_at, so missed saves can be recovered
without client polling. Subscribe-before-read retains state writes during
the opening query; live parts start after the snapshot, with no replay.
A subscriber never receives its own published events, but always receives
opening state (its own lock reads as not held remotely). Server-owned
changes also reach readers without a client id. A cli window relays the
turn it runs through POST /sessions/:id/events, which only the lock holder
may call.

## Cards

Each workspace has schema `wsp_<id>` with `cards`, `card_revisions` and a
trigger that records old values on update and the whole row on delete.
`FIELDS` is the one card field list; the schema check at module load
fails boot if a field lacks a body property. Item ops run under `select
... for update`, all or nothing, keys normalized on both sides. Every
card write calls `ctx.looper.runLoop`; the engine decides eligibility.
Archiving a done card auto-pushes when the setting says so; a failed push
un-archives it into blocked with the reason.

## Tested in

`test/integration.test.ts`, `phase2.test.ts` (tools), `phase3.test.ts`
(git, tasks), `phase4.test.ts` (auto-push, auto-pull, GitHub),
`kanban.test.ts`, `transcripts.test.ts`, `looper.test.ts` (the feeds),
`web.test.ts`, `secrets.test.ts`, `skills.test.ts`.
