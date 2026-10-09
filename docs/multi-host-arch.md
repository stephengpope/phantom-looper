# Session hosts

A session host is a box with Docker and a workspace volume that connects OUT
to the backend and runs workspaces for it. The backend keeps the database and
makes every decision; a host keeps files and containers and does what it is
told. Any number of hosts, anywhere: a server an operator runs, a developer's
Mac, or none at all — the backend itself is a host too.

## The three pieces

**`WorkspaceHost`** (`runtime/WorkspaceHost.ts`) — the ONE interface through
which the backend touches a workspace: checkout, files, git, container, exec,
detached commands, watcher, disk. The backend never opens a workspace path or
a Docker daemon itself.

- `LocalHost` runs the primitives here, against this process's volume and
  Docker. It is the backend's own host on every server, and the body of a session
  host process.
- `RemoteHost` sends the same primitives as jobs over a host's link. A proxy;
  nothing runs in the backend.

**`Link`** (client SDK, `link.ts`) — THE persistent connection, for everything
that holds a line open to the backend: a feed followed forever (stall watchdog,
backoff, a refill hook on reconnect) and sends that are batched, ordered and
never dropped. One transport underneath: HTTPS/2 through Caddy, the backend's
own CA when it runs one. There is no other.

**`SessionHost`** (`host/SessionHost.ts`) — the host process: `LocalHost`
behind a `Link`. Same image as the backend (`phantom-backend`), the host
entrypoint (`dist/phantom-backend/host.js`), one compose file
(`session-host/docker-compose.yml`). No database, no settings, no secrets of
its own — every job carries what it needs.

## What a host is

The key makes it. The root API key registers a **shared** host: any workspace
may land there. A user's API key registers a **user** host: only that
user's workspaces. The backend classifies the key as it does every request;
nothing new to declare.

Identity: the backend assigns an id at the first hello; the host writes it to
`host.json` on its volume, so a reconnect — and a restart — is the same host.
`boot` is fresh per process.

## Placement

Once, when a workspace is created (`Workspaces.checkout`); pinned from then on
(`workspaces.session_host_id`, null = the backend itself). In order:

1. the acting user's own online hosts
2. shared online hosts
3. the backend itself (unless `RUN_SESSION_CONTAINERS=0`)

Within a tier: fewest workspaces with files, then most recently connected. A
host whose box cannot hold the project's `container_disk_gb` is skipped.

## The link

Jobs go DOWN the host's feed (`GET /session-hosts/:id/jobs`, ND-JSON, a
heartbeat every 15 s); events come UP the relay
(`POST /session-hosts/:id/jobs/events`). The vocabulary is `host/protocol.ts`:
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

`POST /sessions/:id/move { session_host_id, wait_ms?, force? }`. A move
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
| session host | a box that runs workspaces for the backend; `session_hosts`, `SessionHosts`, `/api/session-hosts` |
| user host | a session host registered with a user's API key; only their workspaces |
| shared host | a session host registered with the root API key; anyone's workspaces |
| root API key | `API_KEY` in `.env`; the backend's own credential |
| workspace | a checkout and its container; `phantom-backend-session-<id>`, grouped as `phantom-backend-sessions` |
| job | one instruction from the backend to a host, `{ id, type, ... }` |
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
| host stack | `phantom-backend-session-host` → `phantom-backend-session-host`, `phantom-backend-session-host-docker-proxy-1` |
| session containers | `phantom-backend-session-<session id>`, grouped as `phantom-backend-sessions` |
| workspace volume | `phantom-looper-workspaces` |

## Running one

A server: copy `session-host/` out of the image (it rides at
`/host-files/session-host/`), fill `.env` (`BACKEND_URL`, `BACKEND_KEY`,
`HOST_NAME`, `BACKEND_CA` for a backend on its own CA), `docker compose up -d`.

A Mac: `phantom-cli host start`. It extracts that same compose file from the
release image, writes `.env` from the pairing in `~/.phantom-cli/settings.json`,
and brings it up under `~/.phantom-cli/host/`. `stop`, `status`, `logs`.

## Not on a host

Two things stay with the backend's own Docker: the shared agent database
(`agent_database_shared` needs the database container on the same daemon —
a workspace on a session host gets none) and the system skills read off the
workspace image. Disk cleanup measures and sweeps the backend's disk and only
the workspaces on it; a host's disk is its own.
