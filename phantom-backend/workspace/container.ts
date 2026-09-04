// Per-session workspace container lifecycle. The container is STATELESS —
// workspace/, scratch/, logs/ live on the shared volume — so removal is a latency
// event, never a data event. It boots on the first tool call, dies after
// container_idle_ms of no calls, and is recreated transparently.
import type Docker from 'dockerode';
import type { Db } from '../db/client.js';
import type { WorkspaceRow, SessionRow } from '../db/schema.js';
import { resolve } from '../settings.js';
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
  /** Needed only to decrypt the PAT for `agent_git_credentials`. Absent (tests)
   *  means the container never gets a token, whatever the setting says. */
  encryptionKey?: Buffer;
}

export class ContainerManager {
  /** Last tool-call time per session — runtime state, deliberately not a DB
   *  table (a row can disagree with dockerd; this cannot outlive the process
   *  that owns it, and boot removes every phantom container anyway). */
  private lastUsed = new Map<string, number>();
  /** Detached commands currently running, per session. A running command IS
   *  activity — the idle clock does not tick while one is live. */
  private running = new Map<string, number>();
  private inflight = new Map<string, Promise<Docker.Container>>();

  constructor(
    private docker: Docker,
    private paths: Paths,
    private opts: ContainerOpts = {},
  ) {}

  name(sessionId: string): string { return `phantom-looper-ws-${sessionId}`; }

  touch(sessionId: string): void { this.lastUsed.set(sessionId, Date.now()); }
  commandStarted(sessionId: string): void {
    this.running.set(sessionId, (this.running.get(sessionId) ?? 0) + 1);
  }
  commandEnded(sessionId: string): void {
    const n = (this.running.get(sessionId) ?? 1) - 1;
    if (n <= 0) this.running.delete(sessionId); else this.running.set(sessionId, n);
    this.touch(sessionId);
  }

  /** The running container for a session, created if absent. Serialized per
   *  session so two simultaneous tool calls cannot double-create. */
  async ensure(db: Db, session: SessionRow, workspace: WorkspaceRow | undefined): Promise<Docker.Container> {
    // Containers belong to FOLDERS (they mount the checkout). A session that
    // borrows another's folder (the supervisor) shares that folder's
    // container; for owners folderId === id and nothing changes.
    const key = session.folderId ?? session.id;
    this.touch(key);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    const p = this.ensureInner(db, session, workspace).finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private async ensureInner(db: Db, session: SessionRow, workspace: WorkspaceRow | undefined): Promise<Docker.Container> {
    const c = this.docker.getContainer(this.name(session.folderId ?? session.id));
    try {
      const info = await c.inspect();
      if (info.State.Running) return c;
      // Stopped or exited: it holds nothing, so recreate rather than reason
      // about resume states.
      await c.remove({ force: true, v: true }).catch(() => {});
    } catch { /* no such container */ }

    const image = await resolve(db, 'container_image', { workspace });
    const Env = await this.credentialEnv(db, workspace);
    const key = session.folderId ?? session.id;
    const spec = buildContainerSpec({
      name: this.name(key),
      image: String(image),
      labelValue: key,
      env: Env,
      memMb: await resolve(db, 'container_memory_mb'),
      cpus: await resolve(db, 'container_cpus'),
      pids: await resolve(db, 'container_pids_limit'),
      mount: this.opts.volume
        ? { volume: this.opts.volume, subpath: `work/${key}` }
        : { bind: sessionDir(this.paths, key) },
      docker: !!(await resolve(db, 'container_docker', { workspace })),
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
  private async credentialEnv(db: Db, workspace: WorkspaceRow | undefined): Promise<string[]> {
    if (!workspace || !this.opts.encryptionKey) return [];
    if (!(await resolve(db, 'agent_git_credentials', { workspace }))) return [];
    const { pat } = await resolveAuth(db, workspace, this.opts.encryptionKey);
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
    this.lastUsed.delete(sessionId);
    this.running.delete(sessionId);
  }

  /** Kill idle containers. A live detached command counts as activity. */
  async reap(idleMs: number): Promise<void> {
    const now = Date.now();
    for (const [sessionId, last] of this.lastUsed) {
      if (this.running.has(sessionId)) continue;
      if (now - last < idleMs) continue;
      await this.remove(sessionId);
      log.info({ session: sessionId }, 'idle workspace container removed');
    }
  }

  /** Boot: every phantom container predates this process. They are stateless,
   *  so removal is free — and it is the only way memory and dockerd agree. */
  async bootCleanup(): Promise<void> {
    const list = await this.docker.listContainers({ all: true, filters: { label: [SESSION_LABEL] } })
      .catch((e) => { log.warn({ err: errStr(e) }, 'could not list containers at boot'); return []; });
    for (const c of list) {
      await this.docker.getContainer(c.Id).remove({ force: true, v: true }).catch(() => {});
    }
    if (list.length) log.info({ removed: list.length }, 'boot: cleared stale workspace containers');
  }
}
