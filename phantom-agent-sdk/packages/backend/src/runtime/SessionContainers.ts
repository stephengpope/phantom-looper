// The workspace container lifecycle: one container per workspace (checkout),
// shared by every session on it (the coder, its supervisor, the assistant).
// The container is STATELESS — repo/, scratch/, logs/ live on the shared
// volume — so removal is a latency event, never a data event. It boots on the
// first tool call, dies after container_idle_ms of no calls, and is recreated
// transparently.
//
// No in-memory tracking: idle time comes from the workspace's lastUsedAt
// (moved by every tool call and turn save on any of its sessions); running-
// task status comes from background_tasks. Both survive a process restart, so
// containers are never wiped at boot — they stay up and the normal idle reaper
// handles them.
import type Docker from 'dockerode';
import type { ProjectRow } from '../storage/schema.js';
import type { Settings } from '../storage/Settings.js';
import type { AgentDatabases } from '../storage/AgentDatabases.js';
import * as checkoutPool from './CheckoutPool.js';
import type { Paths } from '../lib/paths.js';
import type { Images } from './Images.js';
import { sessionDir } from '../lib/paths.js';
import { logger, errStr } from '../lib/log.js';
import { scopeOf } from '../lib/scopes.js';

const log = logger('container');

/** A container is named by the WORKSPACE it serves: `phantom-looper-ws-<workspace
 *  id>`. The name is the ONE key — it is what ensure/remove open and what the
 *  running-container list reads the id back off. (A label used to carry the
 *  same id under the old "session" name: two keys for one fact; gone.) */
const NAME_PREFIX = 'phantom-looper-ws-';

/** The mount that gives a docker-enabled container its OWN /var/lib/docker on a
 *  real filesystem. An anonymous volume (no Source) is disk-backed, so the inner
 *  dockerd gets the overlay2 graph driver — nesting it on the container's own
 *  overlay upperdir would fall back to vfs (copy-per-layer, unusably slow). It
 *  never touches /workspace, so nothing the agent's docker builds is ever
 *  committed by auto-push, and it dies with the container (remove passes v). */
const DOCKER_GRAPH_MOUNT = { Type: 'volume', Target: '/var/lib/docker' } as const;

interface SpecInput {
  name: string;
  image: string;
  env: string[];
  memMb: number | null;
  cpus: number | null;
  pids: number | null;
  /** Named volume + subpath (production) or a host dir to bind (dev/tests). */
  mount: { volume: string; subpath: string } | { bind: string };
  /** Privileged + the graph volume so the agent can run its own dockerd. The
   *  daemon is NOT started here — the image's `start-docker` does that on demand. */
  docker: boolean;
  /** False: the kernel refuses any gain of privilege (no-new-privileges) —
   *  the image's passwordless sudo stops working, the agent stays itself. */
  sudo: boolean;
  /** The container runtime (gVisor's `runsc`, say); null = Docker's default. */
  runtime: string | null;
  /** The container's own disk, in GB (Docker's StorageOpt size); null = no cap. */
  diskGb: number | null;
  /** The agents' network (AGENT_NETWORK): internet out, no container on it
   *  able to reach another. Absent = Docker's default bridge (dev). */
  network?: string;
}

/** The dockerode createContainer spec — pure, so the docker wiring is a unit
 *  test, not a live privileged container. Cmd stays `sleep infinity` whether or
 *  not docker is on: the capability is create-time flags, never a command. */
export function buildContainerSpec(i: SpecInput): Record<string, unknown> {
  const HostConfig: Record<string, unknown> = {
    Init: true, // sleep never reaps; orphans become zombies without a real PID 1 (verified T19)
    // The same policy every compose service has: a host reboot or a dockerd
    // restart stops every container, and Docker restarts only the ones that
    // carry this. Without it the container sits Exited and ensure() throws it
    // away — everything the agent installed and its own docker images with it.
    // The reaper removes (never stops), so it never fights this. Verified live:
    // after a daemon restart the container is Up with its writable layer intact.
    RestartPolicy: { Name: 'unless-stopped' },
    // null (the default) => omit the field entirely, so Docker applies no cap.
    Memory: i.memMb != null && i.memMb > 0 ? i.memMb * 1024 * 1024 : undefined,
    NanoCpus: i.cpus != null && i.cpus > 0 ? Math.round(i.cpus * 1e9) : undefined,
    PidsLimit: i.pids != null && i.pids > 0 ? i.pids : undefined,
  };
  const mounts: Array<Record<string, unknown>> = [];
  if ('volume' in i.mount) {
    mounts.push({ Type: 'volume', Source: i.mount.volume, Target: '/workspace',
      VolumeOptions: { Subpath: i.mount.subpath } });
  } else {
    HostConfig.Binds = [`${i.mount.bind}:/workspace`];
  }
  if (i.docker) {
    HostConfig.Privileged = true;
    mounts.push({ ...DOCKER_GRAPH_MOUNT });
  }
  if (!i.sudo) HostConfig.SecurityOpt = ['no-new-privileges:true'];
  if (i.runtime) HostConfig.Runtime = i.runtime;
  if (i.diskGb) HostConfig.StorageOpt = { size: `${i.diskGb}G` };
  if (mounts.length) HostConfig.Mounts = mounts;
  if (i.network) HostConfig.NetworkMode = i.network;
  return {
    name: i.name,
    Image: i.image,
    Cmd: ['sleep', 'infinity'], // the command lives at run time, not in the image — any image works
    ...(i.env.length ? { Env: i.env } : {}),
    WorkingDir: '/workspace/repo',
    HostConfig,
  };
}

export interface ContainerOpts {
  /** Named volume holding the project tree. When set, each container mounts
   *  ONLY its session via volume subpath — mount-level isolation, verified
   *  live. Unset (dev/tests) falls back to a bind mount of the session dir. */
  volume?: string;
  /** Where the container's limits, image and credential switch are read.
   *  Absent (tests) means the container never gets a token, whatever the
   *  setting says. */
  settings?: Settings;
  /** The agent databases, for `agent_database_shared`: the container gets
   *  the project's connection string as AGENT_DATABASE_URL. Absent (tests)
   *  means never. */
  databases?: AgentDatabases;
  /** The agents' network (AGENT_NETWORK), made here when missing: a bridge
   *  with inter-container traffic off, so an agent reaches the internet and
   *  nothing on the server — not another agent, not the stack. Its interface
   *  is named after it, for the host's firewall (the metadata block,
   *  scripts/install.sh). Unset (dev) = Docker's default bridge. */
  network?: string;
  /** The database server's container (AGENT_DATABASE_CONTAINER). A container
   *  with AGENT_DATABASE_URL gets a private network of its own that only it
   *  and this container are on — internal, no way out — so the project's
   *  code reaches its database and nothing else of the stack. */
  databaseContainer?: string;
  /** The disk-quota helper (DISK_QUOTA_URL, runtime/diskQuotaHelper.ts):
   *  what holds a checkout to `container_disk_gb`. Absent = no disk limit
   *  can be set. */
  diskQuota?: string;
  /** A container came up for this workspace — awaited before `ensure` returns,
   *  so whatever the caller does next (a file write) happens after the
   *  listener is in place. Instant sync attaches its watcher here. */
  onStarted?: (workspaceId: string, project: ProjectRow | undefined) => Promise<void>;
  /** The workspace's container was removed (idle reap, an explicit remove). */
  onRemoved?: (workspaceId: string) => Promise<void>;
}

export class SessionContainers {
  private inflight = new Map<string, Promise<Docker.Container>>();

  constructor(
    private docker: Docker,
    private images: Images,
    private paths: Paths,
    private opts: ContainerOpts = {},
  ) {}

  name(workspaceId: string): string { return `${NAME_PREFIX}${workspaceId}`; }

  /** Workspace ids that have a running container, read from Docker off the
   *  container names. (Docker's name filter is a substring match, so the
   *  prefix is checked again here.) */
  async activeWorkspaces(): Promise<string[]> {
    const list = await this.docker.listContainers({ filters: { name: [NAME_PREFIX], status: ['running'] } })
      .catch((error) => { log.warn({ err: errStr(error) }, 'could not list containers'); return []; });
    return list.flatMap((container) => (container.Names ?? [])
      .map((name) => name.replace(/^\//, ''))
      .filter((name) => name.startsWith(NAME_PREFIX))
      .map((name) => name.slice(NAME_PREFIX.length)));
  }

  /** The running container for a WORKSPACE, created if absent. Containers
   *  belong to workspaces (they mount the checkout): every session on the
   *  workspace — the coder, its supervisor, the assistant — shares the one.
   *  Serialized per workspace so two simultaneous tool calls cannot
   *  double-create. */
  async ensure(workspaceId: string, project: ProjectRow | undefined): Promise<Docker.Container> {
    const existing = this.inflight.get(workspaceId);
    if (existing) return existing;
    const ensuring = this.ensureInner(workspaceId, project).finally(() => this.inflight.delete(workspaceId));
    this.inflight.set(workspaceId, ensuring);
    return ensuring;
  }

  private async ensureInner(key: string, project: ProjectRow | undefined): Promise<Docker.Container> {
    const container = this.docker.getContainer(this.name(key));
    try {
      const info = await container.inspect();
      if (info.State.Running) return container;
      // Stopped or exited: it holds nothing, so recreate rather than reason
      // about resume states.
      await container.remove({ force: true, v: true }).catch(() => {});
    } catch { /* no such container */ }

    if (!this.opts.settings) throw new Error('SessionContainers needs settings to create a container');
    const limits = await this.opts.settings.resolveMany(
      ['container_image', 'container_memory_mb', 'container_cpus', 'container_pids_limit', 'container_docker', 'container_sudo', 'container_runtime', 'container_disk_gb'],
      project ? scopeOf(project) : {}) as { container_image: string; container_memory_mb: number | null; container_cpus: number | null;
        container_pids_limit: number | null; container_docker: boolean; container_sudo: boolean; container_runtime: string | null; container_disk_gb: number | null };
    const image = limits.container_image;
    const database = await this.databaseEnv(project);
    const Env = [...(await this.credentialEnv(project)), ...database.env];
    if (this.opts.network) await this.agentNetwork();
    const spec = buildContainerSpec({
      name: this.name(key),
      image: String(image),
      env: Env,
      network: this.opts.network,
      memMb: limits.container_memory_mb,
      cpus: limits.container_cpus,
      pids: limits.container_pids_limit,
      mount: this.opts.volume
        ? { volume: this.opts.volume, subpath: `work/${key}` }
        : { bind: sessionDir(this.paths, key) },
      docker: !!limits.container_docker,
      sudo: limits.container_sudo !== false,
      runtime: limits.container_runtime || null,
      diskGb: limits.container_disk_gb || null,
    }) as never;
    let created: Docker.Container;
    try {
      created = await this.docker.createContainer(spec);
    } catch (error) {
      // "No such image": pull it and try once more. The default image is the
      // published workspace image at this server's own version, so a fresh
      // box (or one just upgraded) has nothing local until here. Any other
      // failure surfaces as-is.
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
      log.info({ workspace: key, image }, 'workspace image not present — pulling');
      await this.images.pull(String(image));
      created = await this.docker.createContainer(spec);
    }
    // The checkout held to the same disk limit, before the first process runs.
    if (limits.container_disk_gb) await this.limitCheckout(key, limits.container_disk_gb);
    // Shared database: its private network joined before the first process
    // runs. Not shared (any more): none may linger from before.
    if (database.host) await this.joinDatabaseNetwork(key, created.id, database.host);
    else await this.dropDatabaseNetwork(key);
    await created.start();
    log.info({ workspace: key, image }, 'workspace container started');
    await this.opts.onStarted?.(key, project)
      .catch((error) => log.warn({ workspace: key, err: errStr(error) }, 'onStarted listener failed — container is up regardless'));
    return created;
  }

  /** The agent's own GitHub credential, when `agent_git_credentials` is on.
   *
   *  This is the ONE deliberate hole in "no PAT in a namespace the agent has a
   *  shell in", and it is off by default. The image carries a credential helper
   *  that reads GITHUB_TOKEN, so supplying the variable is all it takes for the
   *  agent's git and gh to be authenticated — nothing is written to the volume,
   *  and the value dies with the container. The chain is the usual one:
   *  github_token at this project's layer, then at the global one.
   *
   *  Env is fixed at create, so a rotated token takes effect when the container
   *  is next recreated (container_idle_ms, or an explicit remove). */
  private async credentialEnv(project: ProjectRow | undefined): Promise<string[]> {
    if (!project || !this.opts.settings) return [];
    if (!(await this.opts.settings.resolve('agent_git_credentials', scopeOf(project)))) return [];
    const { pat } = await checkoutPool.resolveAuth(this.opts.settings, project);
    if (!pat) {
      log.warn({ project: project.name }, 'agent_git_credentials is on but no PAT resolved — container gets none');
      return [];
    }
    log.info({ project: project.name }, 'workspace container gets the GitHub PAT (agent_git_credentials)');
    return [`GITHUB_TOKEN=${pat}`, `GH_TOKEN=${pat}`];
  }

  /** The agent database's connection string, when BOTH `agent_database` and
   *  `agent_database_shared` are on. The second deliberate hole in "the
   *  project's code cannot reach it": the role's password enters the
   *  container's env, and — like the PAT — dies with it. The caller also
   *  joins the stack network, or the host name in the URL resolves nowhere. */
  private async databaseEnv(project: ProjectRow | undefined): Promise<{ env: string[]; host?: string }> {
    if (!project || !this.opts.settings || !this.opts.databases) return { env: [] };
    const on = await this.opts.settings.resolveMany(['agent_database', 'agent_database_shared'], scopeOf(project));
    if (!on.agent_database || !on.agent_database_shared) return { env: [] };
    if (!this.opts.databaseContainer) {
      log.warn({ project: project.name }, 'agent_database_shared is on but AGENT_DATABASE_CONTAINER is unset — the container cannot reach the database');
      return { env: [] };
    }
    const url = await this.opts.databases.urlFor(project.id);
    log.info({ project: project.name }, 'workspace container gets AGENT_DATABASE_URL (agent_database_shared)');
    return { env: [`AGENT_DATABASE_URL=${url}`], host: new URL(url).hostname };
  }

  /** Null when this server can hold an agent to `container_disk_gb`, else
   *  why not — both halves, each proven rather than assumed: Docker creates
   *  (and this removes) a container with a size cap, and the helper reports
   *  project quotas enforced. Settings refuses the value without both. */
  async diskSupport(): Promise<string | null> {
    // Proven by running it: a container capped at 1 GB must SEE 1 GB. Docker's
    // containerd image store (Docker Desktop, and fresh installs' default)
    // accepts the cap and silently ignores it — accepted is not applied.
    const tags = (await this.docker.listImages()).flatMap((one) => one.RepoTags ?? []).filter((tag) => tag !== '<none>:<none>');
    const image = tags.find((tag) => process.env.API_IMAGE && tag.startsWith(process.env.API_IMAGE)) ?? tags[0];
    if (!image) return 'no local image to test Docker with';
    const needs = 'Docker\'s storage must be the overlay2 driver on XFS mounted with pquota';
    let seenKb: number;
    try {
      const probe = await this.docker.createContainer({ Image: image, Entrypoint: ['df', '-Pk', '/'], User: '0', HostConfig: { StorageOpt: { size: '1G' } } });
      try {
        await probe.start();
        await probe.wait();
        const output = String(await probe.logs({ stdout: true, stderr: true }));
        seenKb = Number(/\n\S+\s+(\d+)/.exec(output)?.[1]);
      } finally {
        await probe.remove({ force: true }).catch(() => {});
      }
    } catch (error) {
      return `Docker cannot cap a container's disk here — ${needs} (${(error as Error).message})`;
    }
    if (!(seenKb > 0 && seenKb <= 1.1 * 1024 * 1024)) {
      return `Docker accepted a disk cap but did not apply it (a 1 GB container saw ${Math.round(seenKb / 1024 / 1024)} GB) — ${needs}`;
    }
    if (!this.opts.diskQuota) return 'the disk-quota helper is not configured (DISK_QUOTA_URL)';
    const health = await fetch(`${this.opts.diskQuota}/health`).then((response) => response.json() as Promise<{ ok: boolean; reason?: string }>)
      .catch((error: unknown) => ({ ok: false, reason: `the disk-quota helper is not reachable at ${this.opts.diskQuota} (${(error as Error).message})` }));
    return health.ok ? null : `disk-quota helper: ${health.reason ?? 'not ready'}`;
  }

  /** The checkout held to `gb` (the helper's project quota). Throws: a limit
   *  that cannot be applied stops the container, never runs it unlimited. */
  private async limitCheckout(key: string, gb: number): Promise<void> {
    if (!this.opts.diskQuota) throw new Error('container_disk_gb is set but the disk-quota helper is not configured (DISK_QUOTA_URL)');
    const response = await fetch(`${this.opts.diskQuota}/limit`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: `work/${key}`, gb }) });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; reason?: string };
    if (!body.ok) throw new Error(`could not hold the checkout to ${gb} GB: ${body.reason ?? `HTTP ${response.status}`}`);
  }

  /** The agents' network, made when missing (see ContainerOpts.network).
   *  Checked at every container creation, never remembered: a `docker
   *  network prune` while no agent runs removes it, and the next container
   *  must still find it. Creations are already one per workspace at a time;
   *  a second creator racing this one gets 409 and finds it made. */
  private async agentNetwork(): Promise<void> {
    const name = this.opts.network!;
    if (await this.docker.getNetwork(name).inspect().then(() => true, () => false)) return;
    await this.docker.createNetwork({ Name: name, Driver: 'bridge',
      Options: { 'com.docker.network.bridge.enable_icc': 'false', 'com.docker.network.bridge.name': name.slice(0, 15) } })
      .then(() => log.info({ network: name }, 'agents network created'), (error: unknown) => {
        if ((error as { statusCode?: number }).statusCode !== 409) throw error;
      });
  }

  /** A workspace's private database network: internal (no way out), holding
   *  this container and the database server — reached by the URL's host
   *  name, an alias on this network alone. */
  private databaseNetwork(key: string): string { return `phantom-agentdb-${key}`; }
  private async joinDatabaseNetwork(key: string, containerId: string, host: string): Promise<void> {
    const name = this.databaseNetwork(key);
    const network = this.docker.getNetwork(name);
    await network.inspect().catch(() => this.docker.createNetwork({ Name: name, Driver: 'bridge', Internal: true, Labels: { 'phantom.workspace': key } }));
    const already = (error: unknown) => {
      const status = (error as { statusCode?: number }).statusCode;
      if (status !== 403 && status !== 409) throw error;   // already connected
    };
    await network.connect({ Container: this.opts.databaseContainer!, EndpointConfig: { Aliases: [host] } }).catch(already);
    await network.connect({ Container: containerId }).catch(already);
  }
  /** Gone if there: whoever is still on it is disconnected first (Docker
   *  will not remove a network in use), then the network. */
  private async dropDatabaseNetwork(key: string): Promise<void> {
    const network = this.docker.getNetwork(this.databaseNetwork(key));
    const info = await network.inspect().catch((error: unknown) => {
      if ((error as { statusCode?: number }).statusCode === 404) return null;
      throw error;
    }) as { Containers?: Record<string, unknown> } | null;
    if (!info) return;
    for (const container of Object.keys(info.Containers ?? {})) await network.disconnect({ Container: container, Force: true });
    await network.remove();
  }

  /** Remove the workspace's container. None there (404) is fine — that is the
   *  goal; any other failure throws, so no caller logs a removal that did
   *  not happen. */
  async remove(workspaceId: string): Promise<void> {
    await this.docker.getContainer(this.name(workspaceId)).remove({ force: true, v: true }).catch((error) => {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    });
    await this.dropDatabaseNetwork(workspaceId).catch((error) =>
      log.warn({ workspace: workspaceId, err: errStr(error) }, 'the workspace\'s database network could not be removed'));
    await this.opts.onRemoved?.(workspaceId)
      .catch((error) => log.warn({ workspace: workspaceId, err: errStr(error) }, 'onRemoved listener failed'));
  }

  /** Kill idle containers. `idleWorkspaces` answers from the workspace's lastUsedAt,
   *  background_tasks and session locks — no in-memory state. */
  async reap(idleMs: number, idleWorkspaces: (idleMs: number) => Promise<string[]>): Promise<void> {
    const stale = await idleWorkspaces(idleMs);
    for (const workspaceId of stale) {
      try {
        await this.remove(workspaceId);
        log.info({ workspace: workspaceId }, 'idle workspace container removed');
      } catch (error) {
        log.warn({ workspace: workspaceId, err: errStr(error) }, 'idle workspace container could not be removed');
      }
    }
  }
}
