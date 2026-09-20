// Per-FOLDER workspace container lifecycle: one container per checkout,
// shared by every session on it (the coder, its supervisor, the assistant).
// The container is STATELESS — repo/, scratch/, logs/ live on the shared
// volume — so removal is a latency event, never a data event. It boots on the
// first tool call, dies after container_idle_ms of no calls, and is recreated
// transparently.
//
// No in-memory tracking: idle time comes from the folder's lastUsedAt
// (moved by every tool call and turn save on any of its sessions); running-
// task status comes from background_tasks. Both survive a process restart, so
// containers are never wiped at boot — they stay up and the normal idle reaper
// handles them.
import type Docker from 'dockerode';
import type { WorkspaceRow } from '../db/schema.js';
import type { Settings } from '../settings.js';
import { resolveAuth } from '../pool/pool.js';
import type { Paths } from '../pool/paths.js';
import type { Images } from '../images.js';
import { sessionDir } from '../pool/paths.js';
import { logger, errStr } from '../log.js';

const log = logger('container');

/** A container is named by the FOLDER it serves: `phantom-looper-ws-<folder
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
  /** Named volume holding the workspace tree. When set, each container mounts
   *  ONLY its session via volume subpath — mount-level isolation, verified
   *  live. Unset (dev/tests) falls back to a bind mount of the session dir. */
  volume?: string;
  /** Where the container's limits, image and credential switch are read.
   *  Absent (tests) means the container never gets a token, whatever the
   *  setting says. */
  settings?: Settings;
  /** A container came up for this folder — awaited before `ensure` returns,
   *  so whatever the caller does next (a file write) happens after the
   *  listener is in place. Instant sync attaches its watcher here. */
  onStarted?: (folderId: string, workspace: WorkspaceRow | undefined) => Promise<void>;
  /** The folder's container was removed (idle reap, an explicit remove). */
  onRemoved?: (folderId: string) => Promise<void>;
}

export class ContainerManager {
  private inflight = new Map<string, Promise<Docker.Container>>();

  constructor(
    private docker: Docker,
    private images: Images,
    private paths: Paths,
    private opts: ContainerOpts = {},
  ) {}

  name(folderId: string): string { return `${NAME_PREFIX}${folderId}`; }

  /** Folder ids that have a running container, read from Docker off the
   *  container names. (Docker's name filter is a substring match, so the
   *  prefix is checked again here.) */
  async activeFolders(): Promise<string[]> {
    const list = await this.docker.listContainers({ filters: { name: [NAME_PREFIX], status: ['running'] } })
      .catch((e) => { log.warn({ err: errStr(e) }, 'could not list containers'); return []; });
    return list.flatMap((c) => (c.Names ?? [])
      .map((n) => n.replace(/^\//, ''))
      .filter((n) => n.startsWith(NAME_PREFIX))
      .map((n) => n.slice(NAME_PREFIX.length)));
  }

  /** The running container for a FOLDER, created if absent. Containers
   *  belong to folders (they mount the checkout): every session on the
   *  folder — the coder, its supervisor, the assistant — shares the one.
   *  Serialized per folder so two simultaneous tool calls cannot
   *  double-create. */
  async ensure(folderId: string, workspace: WorkspaceRow | undefined): Promise<Docker.Container> {
    const existing = this.inflight.get(folderId);
    if (existing) return existing;
    const p = this.ensureInner(folderId, workspace).finally(() => this.inflight.delete(folderId));
    this.inflight.set(folderId, p);
    return p;
  }

  private async ensureInner(key: string, workspace: WorkspaceRow | undefined): Promise<Docker.Container> {
    const c = this.docker.getContainer(this.name(key));
    try {
      const info = await c.inspect();
      if (info.State.Running) return c;
      // Stopped or exited: it holds nothing, so recreate rather than reason
      // about resume states.
      await c.remove({ force: true, v: true }).catch(() => {});
    } catch { /* no such container */ }

    if (!this.opts.settings) throw new Error('ContainerManager needs settings to create a container');
    const limits = await this.opts.settings.resolveMany(
      ['container_image', 'container_memory_mb', 'container_cpus', 'container_pids_limit', 'container_docker'],
      { workspace });
    const image = limits.container_image;
    const Env = await this.credentialEnv(workspace);
    const spec = buildContainerSpec({
      name: this.name(key),
      image: String(image),
      env: Env,
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
    } catch (e) {
      // "No such image": pull it and try once more. The default image is the
      // published workspace image at this server's own version, so a fresh
      // box (or one just upgraded) has nothing local until here. Any other
      // failure surfaces as-is.
      if ((e as { statusCode?: number }).statusCode !== 404) throw e;
      log.info({ folder: key, image }, 'workspace image not present — pulling');
      await this.images.pull(String(image));
      created = await this.docker.createContainer(spec);
    }
    await created.start();
    log.info({ folder: key, image }, 'workspace container started');
    await this.opts.onStarted?.(key, workspace)
      .catch((e) => log.warn({ folder: key, err: errStr(e) }, 'onStarted listener failed — container is up regardless'));
    return created;
  }

  /** The agent's own GitHub credential, when `agent_git_credentials` is on.
   *
   *  This is the ONE deliberate hole in "no PAT in a namespace the agent has a
   *  shell in", and it is off by default. The image carries a credential helper
   *  that reads GITHUB_TOKEN, so supplying the variable is all it takes for the
   *  agent's git and gh to be authenticated — nothing is written to the volume,
   *  and the value dies with the container. The chain is the usual one:
   *  github_token at this workspace's layer, then at the global one.
   *
   *  Env is fixed at create, so a rotated token takes effect when the container
   *  is next recreated (container_idle_ms, or an explicit remove). */
  private async credentialEnv(workspace: WorkspaceRow | undefined): Promise<string[]> {
    if (!workspace || !this.opts.settings) return [];
    if (!(await this.opts.settings.resolve('agent_git_credentials', { workspace }))) return [];
    const { pat } = await resolveAuth(this.opts.settings, workspace);
    if (!pat) {
      log.warn({ workspace: workspace.name }, 'agent_git_credentials is on but no PAT resolved — container gets none');
      return [];
    }
    log.info({ workspace: workspace.name }, 'workspace container gets the GitHub PAT (agent_git_credentials)');
    return [`GITHUB_TOKEN=${pat}`, `GH_TOKEN=${pat}`];
  }

  async remove(folderId: string): Promise<void> {
    await this.docker.getContainer(this.name(folderId)).remove({ force: true, v: true }).catch(() => {});
    await this.opts.onRemoved?.(folderId)
      .catch((e) => log.warn({ folder: folderId, err: errStr(e) }, 'onRemoved listener failed'));
  }

  /** Kill idle containers. `idleFolders` answers from the folder's lastUsedAt
   *  and background_tasks — no in-memory state. */
  async reap(idleMs: number, idleFolders: (idleMs: number) => Promise<string[]>): Promise<void> {
    const stale = await idleFolders(idleMs);
    for (const folderId of stale) {
      await this.remove(folderId);
      log.info({ folder: folderId }, 'idle workspace container removed');
    }
  }
}
