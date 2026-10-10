// Runners — the hosts a workspace can be placed on, and where each
// workspace is. The backend's own runner (this process, LocalHost) and every
// registered session runner (a RemoteHost each, online or not). Three jobs:
//
//   PLACEMENT  once, when a workspace is made: the user's own online host if
//              they have one, else a shared runner, else the backend itself.
//              Within a tier: fewest workspaces pinned, then most recently
//              connected. Written to the workspace row; pinned from then on.
//   ROUTING    `of(workspaceId)`: the host a workspace is on. The row's
//              runner_id, cached here; null is the backend's own runner.
//   THE LINK   a host's hello (its row), its feed (jobs down), its relay
//              (events up) — the routes call in here.
//
// A host is what its key makes it: the service role key registers a SHARED runner
// (any user's workspace may land there); a user's key registers a USER
// host (only that user's). The rows live in runners, read and written
// as the backend itself — a user never queries them directly.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Drizzle } from '../storage/Database.js';
import { runners, workspaces, type ProjectRow, type RunnerRow } from '../storage/schema.js';
import type { LocalHost } from '../runtime/LocalHost.js';
import { RemoteHost } from '../runtime/RemoteHost.js';
import type { WorkspaceHost } from '../runtime/WorkspaceHost.js';
import type { Settings } from '../storage/Settings.js';
import type { HostHello, HostLoad, Job, JobEvent } from './protocol.js';
import { tooFull } from '../runtime/Disk.js';
import { newId, type UpdateEvent } from '@phantom-agent-sdk/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { scopeOf } from '../lib/scopes.js';
import { logger, errStr } from '../lib/log.js';

const log = logger('runners');

/** Who is talking to the hosts API: the service role (every host is theirs),
 *  or a user (their own runners). */
export interface HostCaller { admin: boolean; userId: string | null }

export class RunnerError extends Error {
  constructor(readonly code: 'not_found' | 'access_denied' | 'no_host' | 'host_online' | 'host_in_use' | 'host_offline' | 'jobs_running', message: string, readonly retryable = false) { super(message); }
}

export interface RunnerView extends RunnerRow { online: boolean; workspaces: number; load: HostLoad | null; version: string | null;
  /** What it runs (its hello): workspaces, turns, or both. */
  sessions: boolean; clients: boolean }

/** A runner's kinds off its facts; a row from before the split ran sessions. */
export const runsSessions = (facts: { sessions?: boolean }): boolean => facts.sessions ?? true;
export const runsClients = (facts: { clients?: boolean }): boolean => facts.clients ?? false;

/** The runner's heartbeat when no setting says otherwise. */
const HEARTBEAT_MS = 15_000;

/** The workspace whose move the current work IS — its own lookups must not
 *  wait for it (the push and the checkout inside a move go through `of`). */
const inMove = new AsyncLocalStorage<string>();

export class Runners {
  readonly #remote = new Map<string, RemoteHost>();
  /** Each runner's facts as of its last hello: what it runs. */
  readonly #facts = new Map<string, RunnerRow['facts']>();
  /** The open feeds: when each host last spoke, and how to hang up on it. */
  readonly #feeds = new Map<string, { heard: number; close: () => void }>();
  #sweep: ReturnType<typeof setInterval> | null = null;
  /** workspace id → host id (null = the backend itself). Filled at placement and on
   *  first lookup; a move rewrites it. */
  readonly #placement = new Map<string, string | null>();
  /** Workspaces being moved right now: every `of()` waits the move out, so a
   *  tool call mid-move pauses and runs on the new host. */
  readonly #moving = new Map<string, Promise<void>>();

  constructor(
    private readonly database: Drizzle,
    readonly local: LocalHost,
    private readonly opts: { runsContainers: boolean; settings?: Settings },
  ) {}

  /** Whether NEW workspaces may be placed on this server itself
   *  (RUN_SESSION_CONTAINERS=1; the default is 0). What it already holds it
   *  serves either way. */
  get runsContainers(): boolean { return this.opts.runsContainers; }

  /** How often a runner beats (`runner_heartbeat_ms`): told to each at
   *  hello; three silent beats and its feed is hung up on. */
  async heartbeatMs(): Promise<number> {
    const value = Number(await this.opts.settings?.resolve('runner_heartbeat_ms').catch(() => HEARTBEAT_MS) ?? HEARTBEAT_MS);
    return value > 0 ? value : HEARTBEAT_MS;
  }

  /** The registered hosts, as proxies — offline until each connects. */
  async load(): Promise<void> {
    for (const row of await this.database.select().from(runners)) { this.#remote.set(row.id, new RemoteHost(row.id, row.name)); this.#facts.set(row.id, row.facts); }
    log.info({ hosts: this.#remote.size, runsContainers: this.opts.runsContainers }, 'session runners loaded');
    // A feed whose socket died silently (a laptop off the network) is hung
    // up on here: the host is offline, its jobs wait for its next feed. No
    // event up the relay for three beats = dead, whatever the socket says.
    this.#sweep = setInterval(() => {
      void this.heartbeatMs().then((beat) => {
        const cutoff = Date.now() - 3 * beat;
        for (const [id, feed] of this.#feeds) {
          if (feed.heard < cutoff) { log.warn({ host: id }, 'session runner silent — hanging up'); feed.close(); }
        }
      });
    }, HEARTBEAT_MS);
    this.#sweep.unref();
  }

  stop(): void { if (this.#sweep) clearInterval(this.#sweep); }

  // ── routing ───────────────────────────────────────────────────────────

  /** The host a workspace is on. A row that names a host nobody registered
   *  any more reads as the backend itself — the files are gone with it. */
  async of(workspaceId: string): Promise<WorkspaceHost> {
    const moving = this.#moving.get(workspaceId);
    if (moving && inMove.getStore() !== workspaceId) await moving;
    const id = await this.hostIdOf(workspaceId);
    return (id === null ? undefined : this.#remote.get(id)) ?? this.local;
  }

  async hostIdOf(workspaceId: string): Promise<string | null> {
    if (this.#placement.has(workspaceId)) return this.#placement.get(workspaceId)!;
    const [row] = await this.database.select({ hostId: workspaces.runnerId }).from(workspaces).where(eq(workspaces.id, workspaceId));
    const id = row?.hostId ?? null;
    if (row) this.#placement.set(workspaceId, id);
    return id;
  }

  remember(workspaceId: string, hostId: string | null): void { this.#placement.set(workspaceId, hostId); }
  forget(workspaceId: string): void { this.#placement.delete(workspaceId); }

  /** Re-pin a workspace (the move's write); the files are the caller's business. */
  async pin(workspaceId: string, hostId: string | null): Promise<void> {
    await this.database.update(workspaces).set({ runnerId: hostId }).where(eq(workspaces.id, workspaceId));
    this.#placement.set(workspaceId, hostId);
  }

  /** Run `move` with the workspace marked as moving: lookups for it wait
   *  until the move is done (or failed), then see the new pin. */
  async moving<T>(workspaceId: string, move: () => Promise<T>): Promise<T> {
    if (this.#moving.has(workspaceId)) throw new RunnerError('host_in_use', 'this workspace is already being moved');
    let done!: () => void;
    this.#moving.set(workspaceId, new Promise<void>((resolve) => { done = resolve; }));
    try { return await inMove.run(workspaceId, move); }
    finally { this.#moving.delete(workspaceId); done(); }
  }

  byId(id: string | null): WorkspaceHost | undefined { return id === null ? this.local : this.#remote.get(id); }
  /** The SESSION runners whose link is up right now: the ones maintenance
   *  reaches (the warm checkouts, the disk sweep — a client runner has
   *  neither a volume nor Docker). */
  onlineRunners(): RemoteHost[] { return [...this.#remote.values()].filter((host) => host.online && runsSessions(this.#facts.get(host.id) ?? {})); }
  /** The projects that have had a workspace on this runner: the only ones it
   *  is stocked for (a credential goes nowhere it has not already been). */
  async projectsOn(hostId: string): Promise<Set<string>> {
    const rows = await this.database.selectDistinct({ projectId: workspaces.projectId }).from(workspaces).where(eq(workspaces.runnerId, hostId));
    return new Set(rows.map((row) => row.projectId));
  }

  // ── placement ─────────────────────────────────────────────────────────

  /** Where a new workspace of `project` for `userId` goes. The tiers, in order: the user's own online
   *  hosts; shared online hosts; the backend host. Within a tier: a host
   *  that cannot take a checkout — its disk under the sweep's floor, or it
   *  cannot hold the project's disk limit — is not a candidate; the lowest
   *  CPU wins; equal CPUs, one at random. A host that has not beaten yet
   *  reads as idle. */
  async place(project: ProjectRow, userId: string | null): Promise<WorkspaceHost> {
    const rows = await this.database.select().from(runners);
    const online = rows.filter((row) => this.#remote.get(row.id)?.online);
    const settings = this.opts.settings;
    const diskGb = settings ? await settings.resolve<number | null>('container_disk_gb', scopeOf(project)).catch(() => null) : null;
    const pct = settings ? Number(await settings.resolve('disk_cleanup_percent').catch(() => 0)) : 0;
    const loadOf = (row: RunnerRow) => this.#remote.get(row.id)!.load;
    const able = online.filter((row) => runsSessions(row.facts) && (!diskGb || row.facts.diskSupport === null) && !(loadOf(row) && tooFull(loadOf(row)!, pct)));
    const cpuOf = (row: RunnerRow) => loadOf(row)?.cpu ?? 0;
    const least = (tier: RunnerRow[]): RunnerRow | undefined => {
      if (!tier.length) return undefined;
      const best = Math.min(...tier.map(cpuOf));
      const idle = tier.filter((row) => cpuOf(row) === best);
      return idle[Math.floor(Math.random() * idle.length)];
    };
    const chosen = (userId ? least(able.filter((row) => row.ownerUserId === userId)) : undefined)
      ?? least(able.filter((row) => row.ownerUserId === null));
    if (chosen) return this.#remote.get(chosen.id)!;
    if (this.opts.runsContainers) return this.local;
    throw new RunnerError('no_host', userId
      ? 'no session runner is online for you — start one (phantom-cli runner start) or ask for a shared runner'
      : 'no shared runner runner is online, and this server runs no session containers itself');
  }

  /** Where a handed-off turn goes: an online runner that can drive
   *  `agentType` (its hello said so), in the workspace tiers — the user's
   *  own first, then shared — lowest CPU, random among equals. Null when
   *  none can: the server itself drives no handed-off turns. */
  async placeTurn(userId: string | null, agentType: string): Promise<RemoteHost | null> {
    const rows = await this.database.select().from(runners);
    const able = rows.filter((row) => this.#remote.get(row.id)?.online && runsClients(row.facts) && (row.facts.agents ?? []).includes(agentType));
    const cpuOf = (row: RunnerRow) => this.#remote.get(row.id)!.load?.cpu ?? 0;
    const least = (tier: RunnerRow[]): RunnerRow | undefined => {
      if (!tier.length) return undefined;
      const best = Math.min(...tier.map(cpuOf));
      const idle = tier.filter((row) => cpuOf(row) === best);
      return idle[Math.floor(Math.random() * idle.length)];
    };
    const chosen = (userId ? least(able.filter((row) => row.ownerUserId === userId)) : undefined)
      ?? least(able.filter((row) => row.ownerUserId === null));
    return chosen ? this.#remote.get(chosen.id)! : null;
  }

  private async workspaceCounts(hostIds: string[]): Promise<Map<string, number>> {
    if (!hostIds.length) return new Map();
    // Files present: a purged session's row stays, pinned, and holds nothing.
    const rows = await this.database.select({ hostId: workspaces.runnerId, n: sql<number>`count(*)::int` })
      .from(workspaces).where(and(inArray(workspaces.runnerId, hostIds), eq(workspaces.onDisk, true))).groupBy(workspaces.runnerId);
    return new Map(rows.flatMap((row) => (row.hostId ? [[row.hostId, row.n] as const] : [])));
  }

  /** Running containers on every host that can answer right now — this
   *  server's own included whatever it places, for what it still holds. */
  async activeWorkspaces(): Promise<string[]> {
    const lists = await Promise.all([
      this.local.activeWorkspaces().catch(() => [] as string[]),
      ...[...this.#remote.values()].map((host) => host.activeWorkspaces()),
    ]);
    return lists.flat();
  }

  // ── the link ──────────────────────────────────────────────────────────

  private owns(row: RunnerRow, caller: HostCaller): boolean {
    return caller.admin ? row.ownerUserId === null : row.ownerUserId === caller.userId;
  }

  /** A host says hello: its row made or found. The row's owner is the
   *  caller: the service role's hosts are shared, a user's are theirs. A
   *  persisted id that names someone else's row is refused. A CLIENT runner
   *  has no volume to keep an id in, so without one it takes back its own
   *  offline row by name — a recreated container is the same runner. */
  async hello(caller: HostCaller, hello: HostHello): Promise<RunnerRow> {
    const ownerUserId = caller.admin ? null : caller.userId;
    const facts = hello.facts;
    const name = hello.name.trim().slice(0, 80) || 'host';
    const take = async (row: RunnerRow): Promise<RunnerRow> => {
      if (!this.owns(row, caller)) throw new RunnerError('access_denied', 'that host id belongs to someone else');
      const [updated] = await this.database.update(runners).set({ name, facts, boot: hello.boot, lastSeenAt: new Date() })
        .where(eq(runners.id, row.id)).returning();
      this.#remote.get(row.id)!.name = name;
      this.#facts.set(row.id, facts);
      return updated;
    };
    if (hello.id) {
      const [row] = await this.database.select().from(runners).where(eq(runners.id, hello.id));
      if (row) return take(row);
    } else if (facts.clients && !facts.sessions) {
      const rows = await this.database.select().from(runners).where(eq(runners.name, name));
      const own = rows.find((row) => this.owns(row, caller) && runsClients(row.facts) && !runsSessions(row.facts) && !this.#remote.get(row.id)?.online);
      if (own) return take(own);
    }
    const [row] = await this.database.insert(runners)
      .values({ id: hello.id ?? newId(), name, ownerUserId, facts, boot: hello.boot, lastSeenAt: new Date() }).returning();
    this.#remote.set(row.id, new RemoteHost(row.id, name));
    this.#facts.set(row.id, facts);
    log.info({ host: row.id, name, shared: ownerUserId === null, sessions: facts.sessions, clients: facts.clients }, 'runner registered');
    return row;
  }

  /** The host's feed opened: online, with everything unfinished re-sent.
   *  Returns the detach for when it closes. */
  async attach(id: string, caller: HostCaller, boot: string, writer: (job: Job) => void, close: () => void): Promise<() => Promise<void>> {
    const row = await this.rowFor(id, caller);
    const host = this.#remote.get(row.id)!;
    await this.database.update(runners).set({ connectedAt: new Date(), lastSeenAt: new Date(), boot }).where(eq(runners.id, id));
    // One feed per host: a new one replaces the old, which is hung up on.
    this.#feeds.get(id)?.close();
    const feed = { heard: Date.now(), close };
    this.#feeds.set(id, feed);
    host.attach(boot, writer);
    log.info({ host: id, name: row.name }, 'session runner online');
    return async () => {
      if (this.#feeds.get(id) === feed) this.#feeds.delete(id);
      host.unlink(writer);
      await this.database.update(runners).set({ lastSeenAt: new Date() }).where(eq(runners.id, id)).catch(() => {});
      log.info({ host: id, name: row.name }, 'session runner offline');
    };
  }

  async deliver(id: string, caller: HostCaller, events: JobEvent[]): Promise<void> {
    const row = await this.rowFor(id, caller);
    const feed = this.#feeds.get(row.id);
    if (feed) feed.heard = Date.now();
    this.#remote.get(row.id)!.deliver(events);
  }

  /** The host exists and is the caller's — or the refusal. */
  async check(id: string, caller: HostCaller): Promise<void> { await this.rowFor(id, caller); }

  private async rowFor(id: string, caller: HostCaller): Promise<RunnerRow> {
    const [row] = await this.database.select().from(runners).where(eq(runners.id, id));
    if (!row || !this.#remote.has(row.id)) throw new RunnerError('not_found', `no session runner ${id}`);
    if (!this.owns(row, caller)) throw new RunnerError('access_denied', 'access denied');
    return row;
  }

  /** The hosts a caller may see: the service role sees all; a user sees their
   *  own and the shared ones. */
  async list(caller: HostCaller): Promise<RunnerView[]> {
    const rows = await this.database.select().from(runners);
    const visible = rows.filter((row) => caller.admin || row.ownerUserId === null || row.ownerUserId === caller.userId);
    const counts = await this.workspaceCounts(visible.map((row) => row.id));
    return visible.map((row) => ({ ...row, online: this.#remote.get(row.id)?.online ?? false, workspaces: counts.get(row.id) ?? 0, load: this.#remote.get(row.id)?.load ?? null, version: row.facts.version ?? null,
      sessions: runsSessions(row.facts), clients: runsClients(row.facts) }));
  }

  // ── upgrades ──────────────────────────────────────────────────────────

  /** Upgrade one runner to `tag`, as POST /update does the server: the
   *  runner pulls the images and hands the tag to its sidecar; every
   *  UpdateEvent reaches `onEvent` until `restarting` or `error`. The guard
   *  is the server's: jobs in flight (a command running, a task streaming)
   *  die with the restart — refused unless told to restart anyway. The
   *  restart itself may answer before the runner's last chunk: a pending job
   *  failed `host_restarted` IS the restart. */
  async update(id: string, caller: HostCaller, tag: string, options: { restartAnyway?: boolean }, onEvent: (event: UpdateEvent) => void): Promise<void> {
    const row = await this.rowFor(id, caller);
    const host = this.#remote.get(row.id)!;
    if (!host.online) throw new RunnerError('host_offline', `${row.name} is offline`);
    if (host.inFlight > 0 && !options.restartAnyway) {
      throw new RunnerError('jobs_running', `${host.inFlight === 1 ? '1 job is' : `${host.inFlight} jobs are`} in flight on ${row.name} — updating now would cut ${host.inFlight === 1 ? 'it' : 'them'} (they fail retryable); send restart_anyway: true to update anyway`, true);
    }
    const sessionImage = this.opts.settings ? String(await this.opts.settings.resolve('container_image').catch(() => '')).replace(/:[^/]*$/, '') : '';
    log.info({ host: row.id, name: row.name, tag }, 'session runner update requested');
    try {
      for await (const event of host.update(tag, sessionImage)) onEvent(event);
    } catch (error) {
      if ((error as { code?: string }).code === 'host_restarted') { onEvent({ event: 'restarting' }); return; }
      onEvent({ event: 'error', message: errStr(error) });
    }
  }

  /** The runners a caller may update that are online and not on `tag`. */
  async behind(caller: HostCaller, tag: string): Promise<RunnerView[]> {
    return (await this.list(caller)).filter((row) => row.online && row.version !== tag);
  }

  /** Upgrade every runner behind `tag` at once — independent boxes, one
   *  stream; each event names its runner. */
  async updateAll(caller: HostCaller, tag: string, options: { restartAnyway?: boolean }, onEvent: (event: UpdateEvent & { runner: string; name: string }) => void): Promise<void> {
    const targets = await this.behind(caller, tag);
    await Promise.all(targets.map((row) =>
      this.update(row.id, caller, tag, options, (event) => onEvent({ ...event, runner: row.id, name: row.name }))
        .catch((error) => onEvent({ event: 'error', message: errStr(error), runner: row.id, name: row.name }))));
  }

  /** Forget a host: offline, and nothing pinned to it. */
  async remove(id: string, caller: HostCaller): Promise<void> {
    const row = await this.rowFor(id, caller);
    if (this.#remote.get(row.id)!.online) throw new RunnerError('host_online', 'the host is connected — stop it first');
    if ((await this.workspaceCounts([row.id])).get(row.id)) throw new RunnerError('host_in_use', 'workspaces are still on this host — move or delete them first');
    await this.database.delete(runners).where(eq(runners.id, row.id));
    this.#remote.delete(row.id);
  }
}
