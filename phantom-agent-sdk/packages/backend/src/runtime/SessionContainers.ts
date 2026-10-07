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
      // One made before the agents' network (or outside it) is made again on
      // it — stateless, so that is a restart, and it takes today's settings.
      const placed = !this.opts.network || Object.keys(info.NetworkSettings?.Networks ?? {}).includes(this.opts.network);
      if (info.State.Running && placed) return container;
      // Stopped, exited or misplaced: it holds nothing, so recreate rather
      // than reason about resume states.
      await container.remove({ force: true, v: true }).catch(() => {});
    } catch { /* no such container */ }

    if (!this.opts.settings) throw new Error('SessionContainers needs settings to create a container');
    const limits = await this.opts.settings.resolveMany(
      ['container_image', 'container_memory_mb', 'container_cpus', 'container_pids_limit', 'container_docker', 'container_sudo', 'container_runtime'],
      project ? scopeOf(project) : {}) as { container_image: string; container_memory_mb: number | null; container_cpus: number | null;
        container_pids_limit: number | null; container_docker: boolean; container_sudo: boolean; container_runtime: string | null };
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

  /** The agents' network, made once when missing (see ContainerOpts.network). */
  #agentNetwork: Promise<void> | undefined;
  private agentNetwork(): Promise<void> {
    const name = this.opts.network!;
    this.#agentNetwork ??= this.docker.getNetwork(name).inspect().then(() => undefined, async () => {
      await this.docker.createNetwork({ Name: name, Driver: 'bridge',
        Options: { 'com.docker.network.bridge.enable_icc': 'false', 'com.docker.network.bridge.name': name.slice(0, 15) } });
      log.info({ network: name }, 'agents network created');
    }).catch((error: unknown) => { this.#agentNetwork = undefined; throw error; });
    return this.#agentNetwork;
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
  private async dropDatabaseNetwork(key: string): Promise<void> {
    const network = this.docker.getNetwork(this.databaseNetwork(key));
    const gone = (error: unknown) => { if ((error as { statusCode?: number }).statusCode !== 404) throw error; };
    if (this.opts.databaseContainer) await network.disconnect({ Container: this.opts.databaseContainer, Force: true }).catch(gone);
    await network.remove().catch(gone);
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
