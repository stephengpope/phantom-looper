// Per-session workspace container lifecycle. The container is STATELESS —
// workspace/, scratch/, logs/ live on the shared volume — so removal is a latency
// event, never a data event. It boots on the first tool call, dies after
// container_idle_ms of no calls, and is recreated transparently.
//
// No in-memory tracking: idle time comes from the session row's lastUsedAt
// (already updated by every tool call, turn save, and touch); running-command
// status comes from the commands table. Both survive a process restart, so
// containers are never wiped at boot — they stay up and the normal idle reaper
// handles them.
import type Docker from 'dockerode';
import type { WorkspaceRow, SessionRow } from '../db/schema.js';
import type { Settings } from '../settings.js';
import { resolveAuth } from '../pool/pool.js';
import type { Paths } from '../pool/paths.js';
import { sessionDir } from '../pool/paths.js';
import { logger, errStr } from '../log.js';

const log = logger('container');

export const SESSION_LABEL = 'phantom-looper.session';

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
  labelValue: string;
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
    Labels: { [SESSION_LABEL]: i.labelValue },
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
}

export class ContainerManager {
  private inflight = new Map<string, Promise<Docker.Container>>();

  constructor(
    private docker: Docker,
    private paths: Paths,
    private opts: ContainerOpts = {},
  ) {}

  name(sessionId: string): string { return `phantom-looper-ws-${sessionId}`; }

  /** Session ids that have a running container, read from Docker. */
  async activeSessions(): Promise<string[]> {
    const list = await this.docker.listContainers({ filters: { label: [SESSION_LABEL], status: ['running'] } })
      .catch((e) => { log.warn({ err: errStr(e) }, 'could not list containers'); return []; });
    return list.map((c) => c.Labels?.[SESSION_LABEL]).filter((id): id is string => !!id);
  }

  /** The running container for a session, created if absent. Serialized per
   *  session so two simultaneous tool calls cannot double-create. */
  async ensure(session: SessionRow, workspace: WorkspaceRow | undefined): Promise<Docker.Container> {
    // Containers belong to FOLDERS (they mount the checkout). A session that
    // borrows another's folder (the supervisor) shares that folder's
    // container; for owners folderId === id and nothing changes.
    const key = session.folderId ?? session.id;
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.ensureInner(session, workspace).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async ensureInner(session: SessionRow, workspace: WorkspaceRow | undefined): Promise<Docker.Container> {
    const c = this.docker.getContainer(this.name(session.folderId ?? session.id));
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
    const key = session.folderId ?? session.id;
    const spec = buildContainerSpec({
      name: this.name(key),
      image: String(image),
      labelValue: key,
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
      log.info({ session: session.id, image }, 'workspace image not present — pulling');
      await this.pullImage(String(image));
      created = await this.docker.createContainer(spec);
    }
    await created.start();
    log.info({ session: session.id, image }, 'workspace container started');
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

  /** One pull per image at a time — concurrent first sessions on a fresh box
   *  share it instead of each streaming the same layers. */
  private pulls = new Map<string, Promise<void>>();
  private pullImage(image: string): Promise<void> {
    const inflight = this.pulls.get(image);
    if (inflight) return inflight;
    const p = new Promise<void>((res, rej) => {
      this.docker.pull(image, (e: Error | null, stream: NodeJS.ReadableStream) => {
        if (e) return rej(e);
        this.docker.modem.followProgress(stream, (e2: Error | null) => (e2 ? rej(e2) : res()));
      });
    }).then(() => log.info({ image }, 'workspace image pulled'))
      .finally(() => this.pulls.delete(image));
    this.pulls.set(image, p);
    return p;
  }

  async remove(sessionId: string): Promise<void> {
    await this.docker.getContainer(this.name(sessionId)).remove({ force: true, v: true }).catch(() => {});
  }

  /** Kill idle containers. Uses the session's lastUsedAt from the DB and checks
   *  the commands table for running detached commands — no in-memory state. */
  async reap(idleMs: number, idleSessions: (idleMs: number) => Promise<string[]>): Promise<void> {
    const stale = await idleSessions(idleMs);
    for (const sessionId of stale) {
      await this.remove(sessionId);
      log.info({ session: sessionId }, 'idle workspace container removed');
    }
  }
}
