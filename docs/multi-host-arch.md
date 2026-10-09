# Session runners

A session runner is a box with Docker and a workspace volume that connects OUT
to the backend and runs workspaces for it. The backend keeps the database and
makes every decision; a host keeps files and containers and does what it is
told. Any number of hosts, anywhere: a server someone runs, a developer's
Mac, or none at all — the backend itself is a host too.

## The three pieces

**`WorkspaceHost`** (`runtime/WorkspaceHost.ts`) — the ONE interface through
which the backend touches a workspace: checkout, files, git, container, exec,
detached commands, watcher, disk. The backend never opens a workspace path or
a Docker daemon itself.

- `LocalHost` runs the primitives here, against this process's volume and
  Docker. It is the backend's own runner on every server, and the body of a session
  host process.
- `RemoteHost` sends the same primitives as jobs over a host's link. A proxy;
  nothing runs in the backend.

**`Link`** (client SDK, `link.ts`) — THE persistent connection, for everything
that holds a line open to the backend: a feed followed forever (stall watchdog,
backoff, a refill hook on reconnect) and sends that are batched, ordered and
never dropped. One transport underneath: HTTPS/2 through Caddy, the backend's
own CA when it runs one. There is no other.

**`SessionRunner`** (`host/SessionRunner.ts`) — the host process: `LocalHost`
behind a `Link`. Same image as the backend (`phantom-backend`), the host
entrypoint (`dist/phantom-backend/runner.js`), one compose file
(`session-runner/docker-compose.yml`). No database, no settings, no secrets of
its own — every job carries what it needs.

## What a host is

The key makes it. The service role key registers a **shared** host: any workspace
may land there. A user's API key registers a **user** host: only that
user's workspaces. The backend classifies the key as it does every request;
nothing new to declare.

Identity: the backend assigns an id at the first hello; the host writes it to
`host.json` on its volume, so a reconnect — and a restart — is the same host.
`boot` is fresh per process.

## Placement

Once, when a workspace is created (`Workspaces.checkout`); pinned from then on
(`workspaces.session_runner_id`, null = the backend itself). In order:

1. the acting user's own online hosts
2. shared online hosts
3. the backend itself (unless `RUN_SESSION_CONTAINERS=0`)

Within a tier, disk is a filter and CPU is the order: a host under the disk
sweep's floor (`MIN_FREE_GB`), over `disk_cleanup_percent`, or unable to hold
the project's `container_disk_gb` is not a candidate; the lowest `cpu` on the
last heartbeat wins; equal, one at random. A host not yet heard from reads as
idle. The load average is a one-minute average, so a burst can land on one
box; the next beat corrects it.

## The link

Jobs go DOWN the host's feed (`GET /session-runners/:id/jobs`, ND-JSON, a
heartbeat every 15 s); events come UP the relay
(`POST /session-runners/:id/jobs/events`). The vocabulary is `host/protocol.ts`:
one job per primitive; a streaming job (exec output, a detached command, a
watch) sends chunks then `end`.

Liveness both ways: the backend heartbeats down the feed; the host heartbeats
up the relay. A feed silent for 45 s is hung up on; a link silent for 45 s is
torn down and reopened. A dead socket errors on its own only when the OS gives
up on it, minutes later, so neither side waits for that.

**A disconnect is a wait, never a failure.** The host keeps running what it
has; its events queue; a job for an offline host sits pending and goes the
moment the feed is back (the host runs an id once). The one thing that fails
pending jobs is the host coming back as a NEW process: `host_restarted`,
retryable. Background work that must not hang on a closed laptop checks
`host.online` first: the syncs, the sweeps, the refresh.

## Move

`POST /sessions/:id/move { session_runner_id, wait_ms?, force? }`. A move
happens BETWEEN two tool calls, never under one:

1. The workspace is marked moving: every new tool call for it waits.
2. Anything running — a command in flight, a background task — is given
   `wait_ms` (default two minutes) to finish. Past that the move refuses with
   `busy`, unless `force`, which kills it with the container. With `force`
   the only things that can still fail the move are the push, the checkout
   on the new host and the scratch copy — and each leaves the session where
   it was.
3. The branch is pushed from where it is; the scratch pad is copied over.
4. The container and files are removed there; the workspace is re-pinned;
   the branch is checked out on the new host.
5. The waiting tool calls run — on the new host.

The transcript is in the database and the branch is on origin, so the turn
and the cli driving it carry on without noticing. An offline source cannot
push: `force` leaves whatever is unpushed on that box behind.

The DRIVER (the cli running the turn) is a separate matter and needs no
move: the turn's state is the transcript; interrupt the turn anywhere, resume
the session from another machine, send the next message.

## Words

One word per thing, the same in code, routes, docs and what people read:

| word | meaning |
|---|---|
| session runner | a box that runs workspaces for the backend; `session_runners`, `SessionRunners`, `/api/session-runners` |
| user runner | a session runner registered with a user's API key; only their workspaces |
| shared runner | a session runner registered with the service role key; anyone's workspaces |
| service role key | `SERVICE_ROLE_KEY` in `.env` (`ph_service_role_…`); the backend's own credential |
| user role key | a user's own key (`ph_user_role_…`), made at `/api/auth/api-key`; a key's prefix says which it is |
| workspace | a checkout and its container; `phantom-backend-session-<id>`, grouped as `phantom-backend-sessions` |
| host | whatever implements `WorkspaceHost`: a session runner, or the backend itself (`LocalHost`) |
| job | one instruction from the backend to a runner, `{ id, type, ... }` |
| feed | the long GET a host (or a cli) holds open; records come down it |
| relay | the POST a host (or a cli) sends records up on |
| link | one feed plus one relay: the persistent connection (`Link`) |
| move | a workspace re-placed on another host; `POST /api/sessions/:id/move` |

Discriminant fields are `type` (as everywhere in the code); feed records use `event`.

## Names

| | |
|---|---|
| image | `phantom-backend` (backend and host alike) |
| server stack | `phantom-backend` → `phantom-backend-api-1`, … |
| runner stack | `phantom-backend-session-runner` → `phantom-backend-session-runner`, `phantom-backend-session-runner-docker-proxy-1` |
| session containers | `phantom-backend-session-<session id>`, grouped as `phantom-backend-sessions` |
| workspace volume | `phantom-looper-workspaces` |

## Running one

A server: copy `session-runner/` out of the image (it rides at
`/host-files/session-runner/`, the updater scripts with it), fill `.env`
(`BACKEND_URL`, `BACKEND_KEY`, `HOST_NAME`, `RUNNER_DIR` — the directory's
absolute path — and `BACKEND_CA` for a backend on its own CA), `docker compose
up -d`.

A Mac: `phantom-cli runner start`. It extracts that same stack from the
release image, writes `.env` from the pairing in `~/.phantom-cli/settings.json`,
and brings it up under `~/.phantom-cli/runner/`. `stop`, `status`, `logs`,
`update`.

## Upgrading

A runner reports its release in its hello (`facts.version`); the list and
`phantom-cli runner status` show it. Nothing upgrades on its own. The
mechanism is the server's own, run on the runner's box:

1. `POST /api/session-runners/:id/update { tag }` (or the group:
   `POST /api/session-runners/update { tag }`, every online runner the caller
   may use that is not on `tag`) sends the runner an `update` job.
2. The runner pulls the images and writes the tag into `/trigger`
   (`upgrade/updateTask.ts`, the same code `POST /update` runs on the API),
   streaming each `UpdateEvent` up the relay as a chunk; the route streams
   them down as ND-JSON, the group's each with `runner` and `name`.
3. The runner stack's `updater` sidecar (`updater/watch.sh`, the server's)
   spawns the helper that copies `session-runner/` out of the new image into
   `RUNNER_DIR`, pins `BACKEND_TAG` in `.env` and recreates the stack.
4. The recreate ends the link: the stream ends with `restarting` (said by
   the runner as it stops, or read off `host_restarted` when the new boot
   arrives first). Session containers keep running. Jobs in flight fail
   `host_restarted`, retryable — refused beforehand unless `restart_anyway`.
5. The runner comes back on the new release and says hello. The caller
   waits for `version` on the list: `phantom-cli runner update [vX.Y.Z]` for
   this machine's, `phantom-cli update` for all of them after the server.

Order: the server first, then the runners, so the backend always speaks the
newer protocol. `phantom-cli update` does both in that order.

## Not on a host

Two things stay with the backend's own Docker: the shared agent database
(`agent_database_shared` needs the database container on the same daemon —
a workspace on a session runner gets none) and the system skills read off the
workspace image.

## Maintenance

The timer stays on the API; the work runs on the box that holds the volume,
as a job down its feed. Every maintenance tick, each online runner gets:

- `poolTick { projects }` — the warm-checkout tick (`CheckoutPool.tick`)
  against its own volume: evict, refresh, restock one per project. A runner
  is stocked only for projects that have had a workspace on it (the job
  carries the project's git token). A tick landing under a running one is
  dropped; the API does not await it.
- the disk sweep (`Disk.pressureSweep`), once per box: measured with a
  `disk` job, pruned with `removeOldImages { keep }` (never an image a
  container uses), and giving up only the workspaces placed on it. The
  decisions — idle, busy, landed, backed up — are the API's; no credential
  leaves it for this half. The API's own disk is swept whether or not it
  runs containers: every update pulls an image there.

Offline runners are skipped by both.
