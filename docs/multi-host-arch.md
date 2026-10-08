# Multi-Host Architecture

## How It Works Today

One server runs everything. The API container sets `DOCKER_HOST=tcp://docker-proxy:2375`. At boot, `makeDocker()` reads that env var and creates a single dockerode instance. That instance flows through the entire system:

```
makeDocker()  →  PhantomBackend.docker
                      ↓
              SessionContainers(docker, images, paths, opts)
                      ↓
              fsDeps(ctx) = { docker: ctx.docker, sessionContainers: ctx.sessionContainers }
                      ↓
              fileTools(ctx, deps, session, workspaceId)
                      ↓
              deps.sessionContainers.ensure(workspaceId, project)  →  container
                      ↓
              new Sandbox(deps.docker, container)  →  exec commands
```

Every tool call hits the API (`POST /api/tools/:name`). The tool route resolves the session from the DB, calls `ctx.files()` which calls `fileTools()`, which ensures the container and creates a Sandbox. The Sandbox execs commands through dockerode. The client never touches Docker.

The docker-proxy authenticates by network isolation — it sits on an internal Docker network only the API can reach.

## What Changes

Instead of one dockerode instance, the API holds a registry of them — one per host. When a tool call arrives, the API looks up which host owns the session's workspace, gets that host's dockerode instance, and uses it. The rest of the chain (`SessionContainers`, `Sandbox`, tool execution) is unchanged.

Dockerode already works over TCP — proven in testing. `new Docker({ host: '10.0.1.5', port: 2375 })` behaves identically to `new Docker({ socketPath: '/var/run/docker.sock' })`. Container create, exec, remove, inspect — all the same API.

## The Three Scenarios

### Self-Hosted Single Server (unchanged)

The API is its own host. `DOCKER_HOST=tcp://docker-proxy:2375`. One dockerode instance. Same as today.

### Self-Hosted Multi-Server

The operator runs additional hosts on other machines. Each host:
- Runs Docker with TLS on a reachable address
- Has the workspace volume locally
- Runs the checkout pool, git operations, and file watcher locally

The API connects to each host's Docker over TCP/TLS. The operator configures hosts in the API (address, TLS certs). Projects are assigned to hosts via a setting.

The host authenticates to the API with the same `API_KEY` the operator already has. The API authenticates to the host's Docker via TLS client certificates.

### SaaS + Desktop Docker

The user runs Docker locally on their Mac. The API is in the cloud.

The user's machine can't expose a port (NAT). So a small host process runs on the Mac, connects OUT to the API over a WebSocket, and tunnels dockerode API calls from the API to the local Docker daemon.

The host process reads the same credential file the CLI uses (`~/.phantom/config` has `server_url` and `server_key`). Same user, same machine, same credential. No new auth mechanism.

The user runs `phantom host start`. The host process:
1. Reads the credential from `~/.phantom/config`
2. Opens a WebSocket to the API: `wss://api.example.com/api/hosts/connect`
3. Authenticates with the stored credential
4. The API registers it as a host
5. Tool calls for this user's sessions are forwarded over the WebSocket

## The Tool Call Flow (All Scenarios)

```
Client  →  POST /api/tools/bash  →  API
                                      ↓
                              authenticate client (existing auth)
                              resolve session, settings, secrets
                              look up which host owns the workspace
                                      ↓
                              get that host's docker instance
                              (local dockerode, remote TCP, or WebSocket tunnel)
                                      ↓
                              sessionContainers.ensure(workspaceId, project)
                              new Sandbox(docker, container)
                              sandbox.run(cmd)
                                      ↓
Client  ←  result  ←  API
```

The client doesn't know hosts exist. The tool execution code doesn't change. The only variable is which dockerode instance handles the exec.

## Authentication

Two boundaries:

**Client → API**: unchanged. The existing three credential types — `phantomAdminKey` (root API_KEY), `sessionToken` (Better Auth sign-in), `apiKey` (Better Auth API key). Validated by `HttpApi.#frontStep`.

**API → Host Docker**: depends on the scenario:
- Self-hosted local: network isolation (docker-proxy on internal network). Same as today.
- Self-hosted remote: TLS client certificates on the Docker daemon.
- Desktop/NAT: the host connects OUT to the API with the user's credential from `~/.phantom/config`. The API sends dockerode calls over that WebSocket. No inbound connection to the Mac.

## The Filesystem Problem

The API directly touches the workspace volume in these places:

| Module | What it does | How it accesses the filesystem |
|---|---|---|
| `CheckoutPool` | Clones repos, manages warm pool, claims slots | `fs.readdir`, `fs.rename`, `fs.mkdir`, `git clone` |
| `Workspaces` | Creates checkouts, removes files, restores | `fs.rename`, `fs.rm`, `git checkout` |
| `GitSync` | Commits and pushes session branches | `git commit`, `git push` via `repoDir(paths, id)` |
| `InstantSync` | Watches files, triggers auto-push/pull | `WorkspaceWatcher` (parcel/watcher on `repoDir`) |
| `workRefresh` | Reads git state for board dots | `git status` via `repoDir` |
| `Disk` | Measures disk, sweeps old sessions | `statfs`, `du`, `fs.rm` |
| `Web` | Writes fetched pages | `fs.writeFile` to `sessionDir/web/` |
| `Skills` | Scans repo skills | `fs.readdir` on `repoDir/.agents/skills/` |
| `Sessions routes` | Scratch file uploads | `fs.writeFile` to `sessionDir/scratch/` |
| `fs.ts routes` | Bash log spill, task log reads | `fs.writeFile`/`fs.readFile` in `sessionDir/logs/` |
| `TelegramBot` | Reads files to send to user | `fs.readFile` from `sessionDir` |
| `media.ts` | Reads files for media uploads | `fs.readFile` from `sessionDir` |

On a single server, the API container and workspace containers share the same Docker named volume (`phantom-looper-workspaces`). The API reads/writes it directly.

On a remote host, the volume is on the host's machine. The API can't access it.

### Solution

These filesystem operations must run on the host, not the API. They already live in the SDK as standalone modules. On a remote host, the host process runs them locally:

- **CheckoutPool, Workspaces**: the host manages its own pool and checkouts on its own volume
- **GitSync, InstantSync, workRefresh**: the host runs git operations and file watching on its own filesystem
- **Web, Skills, Sessions scratch, fs logs, Telegram, media**: these either go through Sandbox exec (already works remotely via dockerode) or the host process handles them

The host process is the same SDK image (`phantom-backend-api`), different entrypoint. It has all the code. It connects to the API for DB state (sessions, settings, projects) and runs workspace/Docker operations locally.

For the single-server case, nothing changes — the API process does everything itself, same as today.

## Host Registration and Routing

### Host Registry

A `hosts` table in the database:

| Column | Type | Description |
|---|---|---|
| `id` | text (ULID) | Host identifier |
| `name` | text | Human label ("stephens-macbook", "gpu-server-1") |
| `owner` | text | Who registered it (user ID or "operator") |
| `tags` | text[] | Routing labels ("gpu", "local", "us-east") |
| `status` | text | "online" or "offline" |
| `connected_at` | timestamp | When the WebSocket connected |
| `docker_host` | text | TCP address for direct connection (null for WebSocket hosts) |

### Routing

Project-level setting: `session_host`

- **unset (default)**: the API's own local Docker. Backward compatible.
- **`host:<id>`**: pinned to a specific host.
- **`tag:<name>`**: any online host with that tag (API picks least-loaded).

When a workspace is created, the API assigns it to a host based on the project's `session_host` setting. The assignment is stored on the workspace row.

### Migration

Move a session from Host A to Host B:
1. Push any uncommitted work on Host A (git push)
2. Remove the container on Host A
3. Update the workspace's host assignment
4. Next tool call: Host B checks out the repo, creates a new container, continues

Transcript is in the DB. Container is stateless. The agent doesn't notice.

## What Gets Built

### Phase 1: Remote Docker over TCP (self-hosted multi-server)

- `Docker.ts`: `makeDocker()` accepts a host address, returns a dockerode instance per host
- `SessionContainers`: constructor takes a host→Docker map; `ensure()` picks the right one
- `hosts` table and registration endpoint
- `session_host` setting and routing in `fsDeps()`
- Host compose file: Docker socket + workspace volume + the SDK runtime modules

### Phase 2: WebSocket tunnel (desktop/NAT hosts)

- API WebSocket endpoint: `/api/hosts/connect`
- Host process: connects out, authenticates, tunnels dockerode calls
- Credential: reads from `~/.phantom/config` (same as CLI)
- CLI command: `phantom host start` / `phantom host stop`

### Phase 3: Host-side workspace management

- Move CheckoutPool, GitSync, InstantSync, workRefresh, Disk to run on the host process
- Host calls the API for DB state (settings, projects, git credentials)
- API delegates workspace operations to the assigned host
