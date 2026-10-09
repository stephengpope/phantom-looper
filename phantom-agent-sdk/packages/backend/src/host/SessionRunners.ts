// SessionRunners — the hosts a workspace can be placed on, and where each
// workspace is. The backend's own runner (this process, LocalHost) and every
// registered session runner (a RemoteHost each, online or not). Three jobs:
//
//   PLACEMENT  once, when a workspace is made: the user's own online host if
//              they have one, else a shared runner, else the backend itself.
//              Within a tier: fewest workspaces pinned, then most recently
//              connected. Written to the workspace row; pinned from then on.
//   ROUTING    `of(workspaceId)`: the host a workspace is on. The row's
//              session_runner_id, cached here; null is the backend's own runner.
//   THE LINK   a host's hello (its row), its feed (jobs down), its relay
//              (events up) — the routes call in here.
//
// A host is what its key makes it: the service role key registers a SHARED runner
// (any user's workspace may land there); a user's key registers a USER
// host (only that user's). The rows live in session_runners, read and written
// as the backend itself — a user never queries them directly.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Drizzle } from '../storage/Database.js';
import { sessionRunners, workspaces, type ProjectRow, type SessionRunnerRow } from '../storage/schema.js';
import type { LocalHost } from '../runtime/LocalHost.js';
import { RemoteHost } from '../runtime/RemoteHost.js';
import type { WorkspaceHost } from '../runtime/WorkspaceHost.js';
import type { Settings } from '../storage/Settings.js';
import type { HostHello, HostLoad, Job, JobEvent } from './protocol.js';
import { tooFull } from '../runtime/Disk.js';
import { newId } from '@phantom-agent-sdk/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { scopeOf } from '../lib/scopes.js';
import { logger } from '../lib/log.js';

const log = logger('session-runners');

/** Who is talking to the hosts API: the service role (every host is theirs),
 *  or a user (their own runners). */
export interface HostCaller { admin: boolean; userId: string | null }

export class SessionRunnerError extends Error {
  constructor(readonly code: 'not_found' | 'access_denied' | 'no_host' | 'host_online' | 'host_in_use' | 'host_offline', message: string) { super(message); }
}

export interface SessionRunnerView extends SessionRunnerRow { online: boolean; workspaces: number; load: HostLoad | null }

/** No event up the relay for this long = the feed's socket is dead whatever
 *  it says: the host heartbeats every 15 s. */
const SILENT_MS = 45_000;

/** The workspace whose move the current work IS — its own lookups must not
 *  wait for it (the push and the checkout inside a move go through `of`). */
const inMove = new AsyncLocalStorage<string>();

export class SessionRunners {
  readonly #remote = new Map<string, RemoteHost>();
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

  /** Whether this server runs session containers itself (RUN_SESSION_CONTAINERS=1, the default). */
  get runsContainers(): boolean { return this.opts.runsContainers; }

  /** The registered hosts, as proxies — offline until each connects. */
  async load(): Promise<void> {
    for (const row of await this.database.select().from(sessionRunners)) this.#remote.set(row.id, new RemoteHost(row.id, row.name));
    log.info({ hosts: this.#remote.size, runsContainers: this.opts.runsContainers }, 'session runners loaded');
    // A feed whose socket died silently (a laptop off the network) is hung
    // up on here: the host is offline, its jobs wait for its next feed.
    this.#sweep = setInterval(() => {
      const cutoff = Date.now() - SILENT_MS;
      for (const [id, feed] of this.#feeds) {
        if (feed.heard < cutoff) { log.warn({ host: id }, 'session runner silent — hanging up'); feed.close(); }
      }
    }, 15_000);
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
    const [row] = await this.database.select({ hostId: workspaces.sessionRunnerId }).from(workspaces).where(eq(workspaces.id, workspaceId));
    const id = row?.hostId ?? null;
    if (row) this.#placement.set(workspaceId, id);
    return id;
  }

  remember(workspaceId: string, hostId: string | null): void { this.#placement.set(workspaceId, hostId); }
  forget(workspaceId: string): void { this.#placement.delete(workspaceId); }

  /** Re-pin a workspace (the move's write); the files are the caller's business. */
  async pin(workspaceId: string, hostId: string | null): Promise<void> {
    await this.database.update(workspaces).set({ sessionRunnerId: hostId }).where(eq(workspaces.id, workspaceId));
    this.#placement.set(workspaceId, hostId);
  }

  /** Run `move` with the workspace marked as moving: lookups for it wait
   *  until the move is done (or failed), then see the new pin. */
  async moving<T>(workspaceId: string, move: () => Promise<T>): Promise<T> {
    if (this.#moving.has(workspaceId)) throw new SessionRunnerError('host_in_use', 'this workspace is already being moved');
    let done!: () => void;
    this.#moving.set(workspaceId, new Promise<void>((resolve) => { done = resolve; }));
    try { return await inMove.run(workspaceId, move); }
    finally { this.#moving.delete(workspaceId); done(); }
  }

  byId(id: string | null): WorkspaceHost | undefined { return id === null ? this.local : this.#remote.get(id); }

  // ── placement ─────────────────────────────────────────────────────────

  /** Where a new workspace of `project` for `userId` goes (docs/
   *  host-load-placement.md). The tiers, in order: the user's own online
   *  hosts; shared online hosts; the backend host. Within a tier: a host
   *  that cannot take a checkout — its disk under the sweep's floor, or it
   *  cannot hold the project's disk limit — is not a candidate; the lowest
   *  CPU wins; equal CPUs, one at random. A host that has not beaten yet
   *  reads as idle. */
  async place(project: ProjectRow, userId: string | null): Promise<WorkspaceHost> {
    const rows = await this.database.select().from(sessionRunners);
    const online = rows.filter((row) => this.#remote.get(row.id)?.online);
    const settings = this.opts.settings;
    const diskGb = settings ? await settings.resolve<number | null>('container_disk_gb', scopeOf(project)).catch(() => null) : null;
    const pct = settings ? Number(await settings.resolve('disk_cleanup_percent').catch(() => 0)) : 0;
    const loadOf = (row: SessionRunnerRow) => this.#remote.get(row.id)!.load;
    const able = online.filter((row) => (!diskGb || row.facts.diskSupport === null) && !(loadOf(row) && tooFull(loadOf(row)!, pct)));
    const cpuOf = (row: SessionRunnerRow) => loadOf(row)?.cpu ?? 0;
    const least = (tier: SessionRunnerRow[]): SessionRunnerRow | undefined => {
      if (!tier.length) return undefined;
      const best = Math.min(...tier.map(cpuOf));
      const idle = tier.filter((row) => cpuOf(row) === best);
      return idle[Math.floor(Math.random() * idle.length)];
    };
    const chosen = (userId ? least(able.filter((row) => row.ownerUserId === userId)) : undefined)
      ?? least(able.filter((row) => row.ownerUserId === null));
    if (chosen) return this.#remote.get(chosen.id)!;
    if (this.opts.runsContainers) return this.local;
    throw new SessionRunnerError('no_host', userId
      ? 'no session runner is online for you — start one (phantom-cli runner start) or ask for a shared runner'
      : 'no shared runner runner is online, and this server runs no session containers itself');
  }

  private async workspaceCounts(hostIds: string[]): Promise<Map<string, number>> {
    if (!hostIds.length) return new Map();
    // Files present: a purged session's row stays, pinned, and holds nothing.
    const rows = await this.database.select({ hostId: workspaces.sessionRunnerId, n: sql<number>`count(*)::int` })
      .from(workspaces).where(and(inArray(workspaces.sessionRunnerId, hostIds), eq(workspaces.onDisk, true))).groupBy(workspaces.sessionRunnerId);
    return new Map(rows.flatMap((row) => (row.hostId ? [[row.hostId, row.n] as const] : [])));
  }

  /** Running containers on every host that can answer right now. */
  async activeWorkspaces(): Promise<string[]> {
    const lists = await Promise.all([
      this.opts.runsContainers ? this.local.activeWorkspaces() : Promise.resolve([]),
      ...[...this.#remote.values()].map((host) => host.activeWorkspaces()),
    ]);
    return lists.flat();
  }

  // ── the link ──────────────────────────────────────────────────────────

  private owns(row: SessionRunnerRow, caller: HostCaller): boolean {
    return caller.admin ? row.ownerUserId === null : row.ownerUserId === caller.userId;
  }

  /** A host says hello: its row made or found. The row's owner is the
   *  caller: the service role's hosts are shared, a user's are theirs. A
   *  persisted id that names someone else's row is refused. */
  async hello(caller: HostCaller, hello: HostHello): Promise<SessionRunnerRow> {
    const ownerUserId = caller.admin ? null : caller.userId;
    const facts = hello.facts;
    const name = hello.name.trim().slice(0, 80) || 'host';
    if (hello.id) {
      const [row] = await this.database.select().from(sessionRunners).where(eq(sessionRunners.id, hello.id));
      if (row) {
        if (!this.owns(row, caller)) throw new SessionRunnerError('access_denied', 'that host id belongs to someone else');
        const [updated] = await this.database.update(sessionRunners).set({ name, facts, boot: hello.boot, lastSeenAt: new Date() })
          .where(eq(sessionRunners.id, row.id)).returning();
        this.#remote.get(row.id)!.name = name;
        return updated;
      }
    }
    const [row] = await this.database.insert(sessionRunners)
      .values({ id: hello.id ?? newId(), name, ownerUserId, facts, boot: hello.boot, lastSeenAt: new Date() }).returning();
    this.#remote.set(row.id, new RemoteHost(row.id, name));
    log.info({ host: row.id, name, shared: ownerUserId === null }, 'session runner registered');
    return row;
  }

  /** The host's feed opened: online, with everything unfinished re-sent.
   *  Returns the detach for when it closes. */
  async attach(id: string, caller: HostCaller, boot: string, writer: (job: Job) => void, close: () => void): Promise<() => Promise<void>> {
    const row = await this.rowFor(id, caller);
    const host = this.#remote.get(row.id)!;
    await this.database.update(sessionRunners).set({ connectedAt: new Date(), lastSeenAt: new Date(), boot }).where(eq(sessionRunners.id, id));
    // One feed per host: a new one replaces the old, which is hung up on.
    this.#feeds.get(id)?.close();
    const feed = { heard: Date.now(), close };
    this.#feeds.set(id, feed);
    host.attach(boot, writer);
    log.info({ host: id, name: row.name }, 'session runner online');
    return async () => {
      if (this.#feeds.get(id) === feed) this.#feeds.delete(id);
      host.unlink(writer);
      await this.database.update(sessionRunners).set({ lastSeenAt: new Date() }).where(eq(sessionRunners.id, id)).catch(() => {});
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

  private async rowFor(id: string, caller: HostCaller): Promise<SessionRunnerRow> {
    const [row] = await this.database.select().from(sessionRunners).where(eq(sessionRunners.id, id));
    if (!row || !this.#remote.has(row.id)) throw new SessionRunnerError('not_found', `no session runner ${id}`);
    if (!this.owns(row, caller)) throw new SessionRunnerError('access_denied', 'access denied');
    return row;
  }

  /** The hosts a caller may see: the service role sees all; a user sees their
   *  own and the shared ones. */
  async list(caller: HostCaller): Promise<SessionRunnerView[]> {
    const rows = await this.database.select().from(sessionRunners);
    const visible = rows.filter((row) => caller.admin || row.ownerUserId === null || row.ownerUserId === caller.userId);
    const counts = await this.workspaceCounts(visible.map((row) => row.id));
    return visible.map((row) => ({ ...row, online: this.#remote.get(row.id)?.online ?? false, workspaces: counts.get(row.id) ?? 0, load: this.#remote.get(row.id)?.load ?? null }));
  }

  /** Forget a host: offline, and nothing pinned to it. */
  async remove(id: string, caller: HostCaller): Promise<void> {
    const row = await this.rowFor(id, caller);
    if (this.#remote.get(row.id)!.online) throw new SessionRunnerError('host_online', 'the host is connected — stop it first');
    if ((await this.workspaceCounts([row.id])).get(row.id)) throw new SessionRunnerError('host_in_use', 'workspaces are still on this host — move or delete them first');
    await this.database.delete(sessionRunners).where(eq(sessionRunners.id, row.id));
    this.#remote.delete(row.id);
  }
}
