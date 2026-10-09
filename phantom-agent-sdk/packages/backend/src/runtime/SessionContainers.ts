// The workspace container lifecycle: one container per workspace (checkout),
// shared by every session on it (the coder, its supervisor, the assistant).
// The container is STATELESS — repo/, scratch/, logs/ live on the workspace's
// volume — so removal is a latency event, never a data event. It boots on the
// first tool call, dies after container_idle_ms of no calls, and is recreated
// transparently.
//
// This object DECIDES: which image, which limits, which credentials, which
// database — read from the settings in the project's scope — and hands the
// whole plan to the host the workspace is placed on (runtime/WorkspaceHost.ts),
// which creates and starts the container. The backend's own host is this process;
// a session host is a box of its own. The docker calls live there.
//
// No in-memory tracking: idle time comes from the workspace's lastUsedAt
// (moved by every tool call and turn save on any of its sessions); running-
// task status comes from background_tasks. Both survive a process restart, so
// containers are never wiped at boot — they stay up and the normal idle reaper
// handles them.
import type { ProjectRow } from '../storage/schema.js';
import type { Settings } from '../storage/Settings.js';
import type { AgentDatabases } from '../storage/AgentDatabases.js';
import * as checkoutPool from './CheckoutPool.js';
import type { ContainerPlan, ContainerState, WorkspaceHost } from './WorkspaceHost.js';
import type { SessionHosts } from '../host/SessionHosts.js';
import { containerName } from './LocalHost.js';
import { logger, errStr } from '../lib/log.js';
import { scopeOf } from '../lib/scopes.js';

const log = logger('container');

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
  /** Who made it and for what: `phantom.workspace`, `phantom.host`, and the
   *  compose project label that groups them in Docker Desktop. */
  labels?: Record<string, string>;
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
    ...(i.labels ? { Labels: i.labels } : {}),
    WorkingDir: '/workspace/repo',
    HostConfig,
  };
}

export interface ContainerOpts {
  /** Where the container's limits, image and credential switch are read.
   *  Absent (tests) means the container never gets a token, whatever the
   *  setting says. */
  settings?: Settings;
  /** The agent databases, for `agent_database_shared`: the container gets
   *  the project's connection string as AGENT_DATABASE_URL. Absent (tests)
   *  means never. */
  databases?: AgentDatabases;
  /** A container came up for this workspace — awaited before `ensure` returns,
   *  so whatever the caller does next (a file write) happens after the
   *  listener is in place. Instant sync attaches its watcher here. */
  onStarted?: (workspaceId: string, project: ProjectRow | undefined) => Promise<void>;
  /** The workspace's container was removed (idle reap, an explicit remove). */
  onRemoved?: (workspaceId: string) => Promise<void>;
}

export class SessionContainers {
  constructor(
    private hosts: SessionHosts,
    private opts: ContainerOpts = {},
  ) {}

  name(workspaceId: string): string { return containerName(workspaceId); }

  /** Workspace ids that have a running container, on every host. */
  activeWorkspaces(): Promise<string[]> { return this.hosts.activeWorkspaces(); }

  /** The workspace's container, probed on its host — never created. */
  async state(workspaceId: string): Promise<ContainerState> {
    return (await this.hosts.of(workspaceId)).containerState(workspaceId);
  }

  /** The running container for a WORKSPACE, created if absent, on the host
   *  the workspace is placed on. Containers belong to workspaces (they mount
   *  the checkout): every session on the workspace — the coder, its
   *  supervisor, the assistant — shares the one. The host serializes per
   *  workspace, so two simultaneous tool calls cannot double-create. */
  async ensure(workspaceId: string, project: ProjectRow | undefined): Promise<WorkspaceHost> {
    const host = await this.hosts.of(workspaceId);
    if (await host.containerState(workspaceId) === 'running') return host;
    const { created } = await host.containerUp(workspaceId, await this.plan(project, host));
    if (created) {
      await this.opts.onStarted?.(workspaceId, project)
        .catch((error) => log.warn({ workspace: workspaceId, err: errStr(error) }, 'onStarted listener failed — container is up regardless'));
    }
    return host;
  }

  /** Everything the host needs to create the container, read from the
   *  settings in the project's scope. */
  async plan(project: ProjectRow | undefined, host: WorkspaceHost): Promise<ContainerPlan> {
    if (!this.opts.settings) throw new Error('SessionContainers needs settings to create a container');
    const limits = await this.opts.settings.resolveMany(
      ['container_image', 'container_memory_mb', 'container_cpus', 'container_pids_limit', 'container_docker', 'container_sudo', 'container_runtime', 'container_disk_gb'],
      project ? scopeOf(project) : {}) as { container_image: string; container_memory_mb: number | null; container_cpus: number | null;
        container_pids_limit: number | null; container_docker: boolean; container_sudo: boolean; container_runtime: string | null; container_disk_gb: number | null };
    const database = await this.databaseEnv(project, host);
    return {
      image: String(limits.container_image),
      env: [...(await this.credentialEnv(project)), ...database.env],
      memMb: limits.container_memory_mb,
      cpus: limits.container_cpus,
      pids: limits.container_pids_limit,
      docker: !!limits.container_docker,
      sudo: limits.container_sudo !== false,
      runtime: limits.container_runtime || null,
      diskGb: limits.container_disk_gb || null,
      databaseHost: database.host ?? null,
    };
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
   *  container's env, and — like the PAT — dies with it. The host joins the
   *  container to the database server's private network by the host name in
   *  the URL — which only the backend's own host can do: the database server is a
   *  container on THIS daemon. A remote host gets no database. */
  private async databaseEnv(project: ProjectRow | undefined, host: WorkspaceHost): Promise<{ env: string[]; host?: string }> {
    if (!project || !this.opts.settings || !this.opts.databases) return { env: [] };
    const on = await this.opts.settings.resolveMany(['agent_database', 'agent_database_shared'], scopeOf(project));
    if (!on.agent_database || !on.agent_database_shared) return { env: [] };
    if (host.id !== null) {
      log.warn({ project: project.name, host: host.name }, 'agent_database_shared is on but the workspace is on a session host — the container cannot reach the database');
      return { env: [] };
    }
    const url = await this.opts.databases.urlFor(project.id);
    log.info({ project: project.name }, 'workspace container gets AGENT_DATABASE_URL (agent_database_shared)');
    return { env: [`AGENT_DATABASE_URL=${url}`], host: new URL(url).hostname };
  }

  /** Null when the backend's own host can hold a container to `container_disk_gb`. */
  diskSupport(): Promise<string | null> { return this.hosts.local.diskSupport(); }

  /** Remove the workspace's container on its host. None there is fine — that
   *  is the goal; any other failure throws, so no caller logs a removal that
   *  did not happen. */
  async remove(workspaceId: string): Promise<void> {
    await (await this.hosts.of(workspaceId)).containerRemove(workspaceId);
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
