// LocalHost — the workspace primitives, run HERE: this process's volume and
// this process's Docker daemon. It is the backend's own runner on every server
// (the backend holds one and routes to it when a workspace is placed
// nowhere else), and it is the body of a session runner process
// (host/SessionRunner.ts), which runs this same class against its own volume
// and Docker and answers the backend's jobs with it. One implementation of
// every primitive; where it runs is the only difference.
//
// Nothing here decides anything: which image, which limits, what a sync
// does — all of that arrives in the call (runtime/WorkspaceHost.ts).
import type Docker from 'dockerode';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import type { ContainerPlan, ContainerState, DetachEvent, FileType, FileStat, Repo, WorkspaceFiles, WorkspaceHost } from './WorkspaceHost.js';
import { Sandbox, DockerExec } from './Sandbox.js';
import { buildContainerSpec } from './SessionContainers.js';
import type { Images } from './Images.js';
import type { Paths } from '../lib/paths.js';
import { sessionDir, repoDir } from '../lib/paths.js';
import { git, cloneFresh, localRepo, type GitAuth } from '../git/Git.js';
import { claimSlot } from './CheckoutPool.js';
import { WorkspaceWatcher } from '../git/WorkspaceWatcher.js';
import { logger, errStr } from '../lib/log.js';

const log = logger('host');

/** A container is named by the session whose checkout it serves:
 *  `phantom-backend-session-<id>` (the workspace's id IS its owning session's).
 *  The name is the ONE key — it is what up/remove open and what the
 *  running-container list reads the id back off. The session runner's own
 *  container shares the prefix (`phantom-backend-session-runner`), so the list
 *  takes only names whose suffix is an id. */
export const NAME_PREFIX = 'phantom-backend-session-';
const isId = (suffix: string) => /^[0-9a-z]{26}$/i.test(suffix);
/** The names before this one. A container still carrying one is removed at
 *  boot (retireOldContainers): stateless, it comes back under the new name on
 *  the next tool call. Drop these once no install can be on a release before. */
const OLD_NAME_PREFIXES = ['phantom-looper-ws-', 'phantom-backend-workspace-'];
export const containerName = (workspaceId: string): string => `${NAME_PREFIX}${workspaceId}`;

export interface LocalHostOptions {
  /** Named volume holding the project tree. When set, each container mounts
   *  ONLY its workspace via volume subpath — mount-level isolation, verified
   *  live. Unset (dev/tests) falls back to a bind mount of the workspace dir. */
  volume?: string;
  /** The agents' network (AGENT_NETWORK), made here when missing: a bridge
   *  with inter-container traffic off. Unset (dev) = Docker's default bridge. */
  network?: string;
  /** The database server's container (AGENT_DATABASE_CONTAINER): a container
   *  whose plan names a database host joins a private network with it. */
  databaseContainer?: string;
  /** The disk-quota helper (DISK_QUOTA_URL). Absent = no disk limit can be set. */
  diskQuota?: string;
  /** The api image name, for the disk-support probe (API_IMAGE). */
  apiImage?: string;
}

const typeOf = (entry: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): FileType =>
  entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other';

/** One workspace's directory on this filesystem, every path confined to it. */
class LocalFiles implements WorkspaceFiles {
  constructor(private readonly root: string) {}

  /** `rel` under the root, or a throw: `..` never leaves the workspace. */
  private at(rel: string): string {
    const full = path.resolve(this.root, rel);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error(`path leaves the workspace: ${rel}`);
    return full;
  }

  async read(rel: string): Promise<Buffer | null> {
    try { return await fs.readFile(this.at(rel)); }
    catch (error) { if ((error as { code?: string }).code === 'ENOENT') return null; throw error; }
  }
  async write(rel: string, data: Buffer): Promise<void> {
    const full = this.at(rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, data);
  }
  async tail(rel: string, bytes: number): Promise<Buffer> {
    const full = this.at(rel);
    try {
      const stat = await fs.stat(full);
      const from = Math.max(0, stat.size - bytes);
      const handle = await fs.open(full, 'r');
      try {
        const buf = Buffer.alloc(stat.size - from);
        await handle.read(buf, 0, buf.length, from);
        return buf;
      } finally { await handle.close(); }
    } catch { return Buffer.alloc(0); }
  }
  async stat(rel: string): Promise<FileStat | null> {
    try {
      const stat = await fs.lstat(this.at(rel));
      return { size: stat.size, mtimeMs: stat.mtimeMs, type: typeOf(stat) };
    } catch (error) { if ((error as { code?: string }).code === 'ENOENT') return null; throw error; }
  }
  async list(rel: string): Promise<Array<{ name: string; type: FileType }> | null> {
    try {
      const entries = await fs.readdir(this.at(rel), { withFileTypes: true });
      return entries.map((entry) => ({ name: entry.name, type: typeOf(entry) }));
    } catch (error) { if ((error as { code?: string }).code === 'ENOENT') return null; throw error; }
  }
  async mkdir(rel: string): Promise<void> { await fs.mkdir(this.at(rel), { recursive: true }); }
  async rm(rel: string): Promise<void> { await fs.rm(this.at(rel), { recursive: true, force: true }); }
  async realFile(rel: string): Promise<string | null> {
    let resolved: string; let realRoot: string;
    try {
      resolved = await fs.realpath(this.at(rel));
      if (!(await fs.stat(resolved)).isFile()) return null;
      realRoot = await fs.realpath(this.root);
    } catch { return null; }
    return resolved === realRoot || resolved.startsWith(realRoot + path.sep) ? resolved : null;
  }
}

/** The mount that gives a docker-enabled container its OWN /var/lib/docker on a
 *  real filesystem. An anonymous volume (no Source) is disk-backed, so the inner
 *  dockerd gets the overlay2 graph driver — nesting it on the container's own
 *  overlay upperdir would fall back to vfs (copy-per-layer, unusably slow). It
 *  never touches /workspace, so nothing the agent's docker builds is ever
 *  committed by auto-push, and it dies with the container (remove passes v). */
export class LocalHost implements WorkspaceHost {
  readonly id: string | null;
  readonly name: string;
  readonly online = true;
  private readonly watcher = new WorkspaceWatcher();
  /** Serialized per workspace so two simultaneous tool calls cannot double-create. */
  private readonly inflight = new Map<string, Promise<{ created: boolean }>>();

  constructor(
    readonly docker: Docker,
    private readonly images: Images,
    readonly paths: Paths,
    private readonly opts: LocalHostOptions = {},
    identity: { id: string | null; name: string } = { id: null, name: 'backend' },
  ) {
    this.id = identity.id;
    this.name = identity.name;
  }

  /** End the watcher child. */
  stop(): void { this.watcher.stop(); }

  /** Containers still named by the old prefix, removed. They hold nothing —
   *  the checkout is on the volume — so this costs one container start on
   *  the next tool call and nothing else. */
  async retireOldContainers(): Promise<void> {
    const list = await this.docker.listContainers({ all: true }).catch(() => []);
    for (const container of list) {
      const name = (container.Names ?? [])[0]?.replace(/^\//, '') ?? '';
      if (!OLD_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      await this.docker.getContainer(container.Id).remove({ force: true, v: true })
        .then(() => log.info({ container: name }, 'old-named workspace container removed — it comes back under the new name'))
        .catch((error) => log.warn({ container: name, err: errStr(error) }, 'old-named workspace container could not be removed'));
    }
  }

  // ── the checkout ──────────────────────────────────────────────────────

  async checkout(workspaceId: string, projectId: string, branch: string, auth: GitAuth): Promise<'claimed' | 'cloned'> {
    const dest = sessionDir(this.paths, workspaceId);
    const dir = repoDir(this.paths, workspaceId);
    const claimed = await claimSlot(this.paths, projectId, branch, dest);
    if (claimed) {
      // Pool slots are pristine by construction, so the unguarded catch-up is
      // safe — and mandatory: a slot stocked days ago is days behind.
      await git(dir, ['fetch', 'origin', branch], auth);
      await git(dir, ['reset', '--hard', `origin/${branch}`], auth);
    } else {
      await cloneFresh(dir, auth, branch);
      await fs.mkdir(`${dest}/scratch`, { recursive: true });
    }
    await fs.mkdir(`${dest}/logs`, { recursive: true }); // detached exec logs — outside repo/, or add -A commits them
    return claimed ? 'claimed' : 'cloned';
  }

  async removeFiles(workspaceId: string): Promise<void> {
    await fs.rm(sessionDir(this.paths, workspaceId), { recursive: true, force: true });
  }

  repo(workspaceId: string): Repo { return localRepo(repoDir(this.paths, workspaceId)); }
  files(workspaceId: string): WorkspaceFiles { return new LocalFiles(sessionDir(this.paths, workspaceId)); }

  // ── the container ─────────────────────────────────────────────────────

  containerUp(workspaceId: string, plan: ContainerPlan): Promise<{ created: boolean }> {
    const existing = this.inflight.get(workspaceId);
    if (existing) return existing;
    const bringing = this.upInner(workspaceId, plan).finally(() => this.inflight.delete(workspaceId));
    this.inflight.set(workspaceId, bringing);
    return bringing;
  }

  private async upInner(key: string, plan: ContainerPlan): Promise<{ created: boolean }> {
    const container = this.docker.getContainer(containerName(key));
    try {
      const info = await container.inspect();
      if (info.State.Running) return { created: false };
      // Stopped or exited: it holds nothing, so recreate rather than reason
      // about resume states.
      await container.remove({ force: true, v: true }).catch(() => {});
    } catch { /* no such container */ }

    if (this.opts.network) await this.agentNetwork();
    const spec = buildContainerSpec({
      name: containerName(key),
      image: plan.image,
      env: plan.env,
      network: this.opts.network,
      memMb: plan.memMb,
      cpus: plan.cpus,
      pids: plan.pids,
      mount: this.opts.volume
        ? { volume: this.opts.volume, subpath: `work/${key}` }
        : { bind: sessionDir(this.paths, key) },
      docker: plan.docker,
      sudo: plan.sudo,
      runtime: plan.runtime,
      diskGb: plan.diskGb,
      // Provenance on the container itself: which host made it, for which
      // workspace. The compose label groups them as one project in Docker
      // Desktop (and `docker compose -p phantom-backend-sessions ps`).
      labels: { 'phantom.workspace': key, 'phantom.host': this.name, 'com.docker.compose.project': 'phantom-backend-sessions' },
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
      log.info({ workspace: key, image: plan.image }, 'workspace image not present — pulling');
      await this.images.pull(plan.image);
      created = await this.docker.createContainer(spec);
    }
    // The checkout held to the same disk limit, before the first process runs.
    if (plan.diskGb) await this.limitCheckout(key, plan.diskGb);
    // Shared database: its private network joined before the first process
    // runs. Not shared (any more): none may linger from before.
    if (plan.databaseHost) await this.joinDatabaseNetwork(key, created.id, plan.databaseHost);
    else await this.dropDatabaseNetwork(key);
    await created.start();
    log.info({ workspace: key, image: plan.image }, 'workspace container started');
    return { created: true };
  }

  /** Remove the workspace's container. None there (404) is fine — that is the
   *  goal; any other failure throws, so no caller logs a removal that did
   *  not happen. */
  async containerRemove(workspaceId: string): Promise<void> {
    await this.docker.getContainer(containerName(workspaceId)).remove({ force: true, v: true }).catch((error) => {
      if ((error as { statusCode?: number }).statusCode !== 404) throw error;
    });
    await this.dropDatabaseNetwork(workspaceId).catch((error) =>
      log.warn({ workspace: workspaceId, err: errStr(error) }, 'the workspace\'s database network could not be removed'));
  }

  async containerState(workspaceId: string): Promise<ContainerState> {
    const info = await this.docker.getContainer(containerName(workspaceId)).inspect()
      .catch((error: { statusCode?: number; message?: string }) => {
        // 404 IS "absent"; anything else is docker failing to answer.
        if (error.statusCode !== 404) log.warn({ workspace: workspaceId, err: error.message }, 'container inspect failed — listed as absent');
        return null;
      });
    if (!info) return 'absent';
    return info.State.Running ? 'running' : 'stopped';
  }

  /** Workspace ids that have a running container, read from Docker off the
   *  container names. (Docker's name filter is a substring match, so the
   *  prefix is checked again here.) */
  async activeWorkspaces(): Promise<string[]> {
    const list = await this.docker.listContainers({ filters: { name: [NAME_PREFIX], status: ['running'] } })
      .catch((error) => { log.warn({ err: errStr(error) }, 'could not list containers'); return []; });
    return list.flatMap((container) => (container.Names ?? [])
      .map((name) => name.replace(/^\//, ''))
      .filter((name) => name.startsWith(NAME_PREFIX))
      .map((name) => name.slice(NAME_PREFIX.length))
      .filter(isId));
  }

  sandbox(workspaceId: string): Sandbox {
    return new Sandbox(new DockerExec(this.docker, this.docker.getContainer(containerName(workspaceId))));
  }

  /** The detached command: its stream written to `logs/<taskId>.ndjson` as it
   *  arrives, its sid read off the pidfile the wrapper writes (the exec spawn
   *  can lag a beat on a just-started container, so the read retries), its end
   *  reported last. The log is the agent's to read at /workspace/logs/. */
  async *detach(workspaceId: string, taskId: string, argv: string[], cwd: string | undefined, sidfile: string): AsyncIterable<DetachEvent> {
    const sandbox = this.sandbox(workspaceId);
    const logPath = path.join(sessionDir(this.paths, workspaceId), 'logs', `${taskId}.ndjson`);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    const out = createWriteStream(logPath);
    // Two producers (the sid read, the stream), one ordered queue of events.
    const queue: DetachEvent[] = [];
    let wake: (() => void) | null = null;
    let pending = 2;
    const push = (event: DetachEvent | null) => { if (event) queue.push(event); else pending--; wake?.(); };
    void (async () => {
      const script =
        's=""; for i in 1 2 3 4 5 6 7 8 9 10; do s=$(cat "$0" 2>/dev/null) && [ -n "$s" ] && break; sleep 0.3; done; ' +
        'rm -f "$0"; printf %s "$s"';
      const ran = await sandbox.run(['/bin/sh', '-c', script, sidfile], { timeoutMs: 10_000 });
      const sid = ran.stdout.toString('utf8').trim();
      if (/^\d+$/.test(sid)) push({ event: 'sid', sid });
    })().catch((error) => log.warn({ taskId, err: errStr(error) }, 'detached sid capture failed')).finally(() => push(null));
    void (async () => {
      let exitCode: number | null = null;
      let status: 'exited' | 'killed' | 'orphaned' = 'exited';
      try {
        for await (const record of sandbox.runStream(argv, { cwd })) {
          out.write(JSON.stringify(record) + '\n');
          if (record.event === 'exit') exitCode = record.code ?? -1;
          if (record.event === 'error') status = 'killed';
        }
      } catch (error) {
        status = 'orphaned';
        out.write(JSON.stringify({ seq: -1, event: 'error', reason: 'container_gone' }) + '\n');
        log.warn({ taskId, err: errStr(error) }, 'detached stream died');
      } finally {
        out.end();
      }
      push({ event: 'exit', status, exitCode });
    })().finally(() => push(null));
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (pending === 0) return;
      await new Promise<void>((resume) => { wake = resume; });
      wake = null;
    }
  }

  // ── the watcher ───────────────────────────────────────────────────────

  watch(workspaceId: string, onChange: () => void): void {
    this.watcher.watch(workspaceId, repoDir(this.paths, workspaceId), onChange);
  }
  unwatch(workspaceId: string): void { this.watcher.unwatch(workspaceId); }

  // ── the box ───────────────────────────────────────────────────────────

  /** The project filesystem, read once. The named volume and docker's own
   *  data share the host's one disk in any standard install, so this speaks
   *  for both. `bavail` (what an unprivileged user may still use) is the
   *  honest measure of "full". */
  async disk(): Promise<{ usedPct: number; freeGB: number }> {
    const stat = await fs.statfs(this.paths.root);
    if (stat.blocks === 0) return { usedPct: 0, freeGB: Infinity };
    return {
      usedPct: ((stat.blocks - stat.bavail) / stat.blocks) * 100,
      freeGB: (stat.bavail * stat.bsize) / (1024 ** 3),
    };
  }

  /** Null when this host can hold an agent to `container_disk_gb`, else
   *  why not — both halves, each proven rather than assumed: Docker creates
   *  (and this removes) a container with a size cap, and the helper reports
   *  project quotas enforced. */
  async diskSupport(): Promise<string | null> {
    // Proven by running it: a container capped at 1 GB must SEE 1 GB. Docker's
    // containerd image store (Docker Desktop, and fresh installs' default)
    // accepts the cap and silently ignores it — accepted is not applied.
    const tags = (await this.docker.listImages()).flatMap((one) => one.RepoTags ?? []).filter((tag) => tag !== '<none>:<none>');
    const image = tags.find((tag) => this.opts.apiImage && tag.startsWith(this.opts.apiImage)) ?? tags[0];
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

  // ── docker plumbing ───────────────────────────────────────────────────

  /** The checkout held to `gb` (the helper's project quota). Throws: a limit
   *  that cannot be applied stops the container, never runs it unlimited. */
  private async limitCheckout(key: string, gb: number): Promise<void> {
    if (!this.opts.diskQuota) throw new Error('container_disk_gb is set but the disk-quota helper is not configured (DISK_QUOTA_URL)');
    const response = await fetch(`${this.opts.diskQuota}/limit`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: `work/${key}`, gb }) });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; reason?: string };
    if (!body.ok) throw new Error(`could not hold the checkout to ${gb} GB: ${body.reason ?? `HTTP ${response.status}`}`);
  }

  /** The agents' network, made when missing (LocalHostOptions.network).
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
    if (!this.opts.databaseContainer) {
      log.warn({ workspace: key }, 'the plan names a database host but AGENT_DATABASE_CONTAINER is unset on this host — the container cannot reach the database');
      return;
    }
    const name = this.databaseNetwork(key);
    const network = this.docker.getNetwork(name);
    await network.inspect().catch(() => this.docker.createNetwork({ Name: name, Driver: 'bridge', Internal: true, Labels: { 'phantom.workspace': key } }));
    const already = (error: unknown) => {
      const status = (error as { statusCode?: number }).statusCode;
      if (status !== 403 && status !== 409) throw error;   // already connected
    };
    await network.connect({ Container: this.opts.databaseContainer, EndpointConfig: { Aliases: [host] } }).catch(already);
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
}
