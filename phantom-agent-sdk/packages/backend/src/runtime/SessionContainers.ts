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
  /** A Docker network to join instead of the default bridge — the stack's
   *  own, when the agent database is shared with the project (its host name
   *  resolves only there). Absent = Docker's default. */
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
  /** The stack's Docker network (compose's `<project>_default`), which a
   *  container joins when it carries AGENT_DATABASE_URL — the URL's host
   *  resolves only there. Unset (dev, no compose) = the URL is handed out
   *  but the container stays on the default bridge. */
  network?: string;
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
      ['container_image', 'container_memory_mb', 'container_cpus', 'container_pids_limit', 'container_docker'],
      project ? { projectId: project.id } : {}) as { container_image: string; container_memory_mb: number | null; container_cpus: number | null; container_pids_limit: number | null; container_docker: boolean };
    const image = limits.container_image;
    const database = await this.databaseEnv(project);
    const Env = [...(await this.credentialEnv(project)), ...database];
    const spec = buildContainerSpec({
      name: this.name(key),
      image: String(image),
      env: Env,
      network: database.length ? this.opts.network : undefined,
      memMb: limits.container_memory_mb,
      cpus: limits.container_cpus,
      pids: limits.container_pids_limit,
      mount: this.opts.volume
        ? { volume: this.opts.volume, subpath: `work/${key}` }
        : { bind: sessionDir(this.paths, key) },
      docker: !!limits.container_docker,
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
    if (!(await this.opts.settings.resolve('agent_git_credentials', { projectId: project.id }))) return [];
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
  private async databaseEnv(project: ProjectRow | undefined): Promise<string[]> {
    if (!project || !this.opts.settings || !this.opts.databases) return [];
    const on = await this.opts.settings.resolveMany(['agent_database', 'agent_database_shared'], { projectId: project.id });
    if (!on.agent_database || !on.agent_database_shared) return [];
    if (!this.opts.network) {
      log.warn({ project: project.name }, 'agent_database_shared is on but WORKSPACE_NETWORK is unset — the URL\'s host may not resolve from the container');
    }
    log.info({ project: project.name }, 'workspace container gets AGENT_DATABASE_URL (agent_database_shared)');
    return [`AGENT_DATABASE_URL=${await this.opts.databases.urlFor(project.id)}`];
  }

  /** Remove the workspace's container. None there (404) is fine — that is the
   *  goal; any other failure throws, so no caller logs a removal that did
   *  not happen. */
  async remove(workspaceId: string): Promise<void> {
    await this.docker.getContainer(this.name(workspaceId)).remove({ force: true, v: true }).catch((error) => {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    });
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
