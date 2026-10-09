// SessionHosts — the hosts a workspace can be placed on, and where each
// workspace is. The backend's own host (this process, LocalHost) and every
// registered session host (a RemoteHost each, online or not). Three jobs:
//
//   PLACEMENT  once, when a workspace is made: the user's own online host if
//              they have one, else a shared host, else the backend itself.
//              Within a tier: fewest workspaces pinned, then most recently
//              connected. Written to the workspace row; pinned from then on.
//   ROUTING    `of(workspaceId)`: the host a workspace is on. The row's
//              session_host_id, cached here; null is the backend's own host.
//   THE LINK   a host's hello (its row), its feed (jobs down), its relay
//              (events up) — the routes call in here.
//
// A host is what its key makes it: the root API key registers a SHARED host
// (any user's workspace may land there); a user's key registers a USER
// host (only that user's). The rows live in session_hosts, read and written
// as the backend itself — a user never queries them directly.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Drizzle } from '../storage/Database.js';
import { sessionHosts, workspaces, type ProjectRow, type SessionHostRow } from '../storage/schema.js';
import type { LocalHost } from '../runtime/LocalHost.js';
import { RemoteHost } from '../runtime/RemoteHost.js';
import type { WorkspaceHost } from '../runtime/WorkspaceHost.js';
import type { Settings } from '../storage/Settings.js';
import type { HostHello, Job, JobEvent } from './protocol.js';
import { newId } from '@phantom-agent-sdk/client';
import { scopeOf } from '../lib/scopes.js';
import { logger } from '../lib/log.js';

const log = logger('session-hosts');

/** Who is talking to the hosts API: the root API key (every host is theirs),
 *  or a user (their own hosts). */
export interface HostCaller { admin: boolean; userId: string | null }

export class SessionHostError extends Error {
  constructor(readonly code: 'not_found' | 'access_denied' | 'no_host' | 'host_online' | 'host_in_use' | 'host_offline', message: string) { super(message); }
}

export interface SessionHostView extends SessionHostRow { online: boolean; workspaces: number }

/** No event up the relay for this long = the feed's socket is dead whatever
 *  it says: the host heartbeats every 15 s. */
const SILENT_MS = 45_000;

export class SessionHosts {
  readonly #remote = new Map<string, RemoteHost>();
  /** The open feeds: when each host last spoke, and how to hang up on it. */
  readonly #feeds = new Map<string, { heard: number; close: () => void }>();
  #sweep: ReturnType<typeof setInterval> | null = null;
  /** workspace id → host id (null = the backend itself). Filled at placement and on
   *  first lookup; a move rewrites it. */
  readonly #placement = new Map<string, string | null>();

  constructor(
    private readonly database: Drizzle,
    readonly local: LocalHost,
    private readonly opts: { runsContainers: boolean; settings?: Settings },
  ) {}

  /** Whether this server runs session containers itself (RUN_SESSION_CONTAINERS=1, the default). */
  get runsContainers(): boolean { return this.opts.runsContainers; }

  /** The registered hosts, as proxies — offline until each connects. */
  async load(): Promise<void> {
    for (const row of await this.database.select().from(sessionHosts)) this.#remote.set(row.id, new RemoteHost(row.id, row.name));
    log.info({ hosts: this.#remote.size, runsContainers: this.opts.runsContainers }, 'session hosts loaded');
    // A feed whose socket died silently (a laptop off the network) is hung
    // up on here: the host is offline, its jobs wait for its next feed.
    this.#sweep = setInterval(() => {
      const cutoff = Date.now() - SILENT_MS;
      for (const [id, feed] of this.#feeds) {
        if (feed.heard < cutoff) { log.warn({ host: id }, 'session host silent — hanging up'); feed.close(); }
      }
    }, 15_000);
    this.#sweep.unref();
  }

  stop(): void { if (this.#sweep) clearInterval(this.#sweep); }

  // ── routing ───────────────────────────────────────────────────────────

  /** The host a workspace is on. A row that names a host nobody registered
   *  any more reads as the backend itself — the files are gone with it. */
  async of(workspaceId: string): Promise<WorkspaceHost> {
    const id = await this.hostIdOf(workspaceId);
    return (id === null ? undefined : this.#remote.get(id)) ?? this.local;
  }

  async hostIdOf(workspaceId: string): Promise<string | null> {
    if (this.#placement.has(workspaceId)) return this.#placement.get(workspaceId)!;
    const [row] = await this.database.select({ hostId: workspaces.sessionHostId }).from(workspaces).where(eq(workspaces.id, workspaceId));
    const id = row?.hostId ?? null;
    if (row) this.#placement.set(workspaceId, id);
    return id;
  }

  remember(workspaceId: string, hostId: string | null): void { this.#placement.set(workspaceId, hostId); }
  forget(workspaceId: string): void { this.#placement.delete(workspaceId); }

  /** Re-pin a workspace (the move's write); the files are the caller's business. */
  async pin(workspaceId: string, hostId: string | null): Promise<void> {
    await this.database.update(workspaces).set({ sessionHostId: hostId }).where(eq(workspaces.id, workspaceId));
    this.#placement.set(workspaceId, hostId);
  }

  byId(id: string | null): WorkspaceHost | undefined { return id === null ? this.local : this.#remote.get(id); }

  // ── placement ─────────────────────────────────────────────────────────

  /** Where a new workspace of `project` for `userId` goes. The rule, in
   *  order: the user's own online hosts; shared online hosts; the backend
   *  host. Within a tier: fewest workspaces pinned, then most recently
   *  connected. A host that cannot hold the project's disk limit is skipped. */
  async place(project: ProjectRow, userId: string | null): Promise<WorkspaceHost> {
    const rows = await this.database.select().from(sessionHosts);
    const online = rows.filter((row) => this.#remote.get(row.id)?.online);
    const diskGb = this.opts.settings ? await this.opts.settings.resolve<number | null>('container_disk_gb', scopeOf(project)).catch(() => null) : null;
    const able = online.filter((row) => !diskGb || row.facts.diskSupport === null);
    const counts = await this.workspaceCounts(able.map((row) => row.id));
    const order = (a: SessionHostRow, b: SessionHostRow) =>
      (counts.get(a.id) ?? 0) - (counts.get(b.id) ?? 0)
      || (b.connectedAt?.getTime() ?? 0) - (a.connectedAt?.getTime() ?? 0);
    const own = userId ? able.filter((row) => row.ownerUserId === userId).sort(order) : [];
    const shared = able.filter((row) => row.ownerUserId === null).sort(order);
    const chosen = own[0] ?? shared[0];
    if (chosen) return this.#remote.get(chosen.id)!;
    if (this.opts.runsContainers) return this.local;
    throw new SessionHostError('no_host', userId
      ? 'no session host is online for you — start one (phantom host start) or ask for a shared host'
      : 'no shared session host is online, and this server runs no session containers itself');
  }

  private async workspaceCounts(hostIds: string[]): Promise<Map<string, number>> {
    if (!hostIds.length) return new Map();
    // Files present: a purged session's row stays, pinned, and holds nothing.
    const rows = await this.database.select({ hostId: workspaces.sessionHostId, n: sql<number>`count(*)::int` })
      .from(workspaces).where(and(inArray(workspaces.sessionHostId, hostIds), eq(workspaces.onDisk, true))).groupBy(workspaces.sessionHostId);
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

  private owns(row: SessionHostRow, caller: HostCaller): boolean {
    return caller.admin ? row.ownerUserId === null : row.ownerUserId === caller.userId;
  }

  /** A host says hello: its row made or found. The row's owner is the
   *  caller: the root API key's hosts are shared, a user's are theirs. A
   *  persisted id that names someone else's row is refused. */
  async hello(caller: HostCaller, hello: HostHello): Promise<SessionHostRow> {
    const ownerUserId = caller.admin ? null : caller.userId;
    const facts = hello.facts;
    const name = hello.name.trim().slice(0, 80) || 'host';
    if (hello.id) {
      const [row] = await this.database.select().from(sessionHosts).where(eq(sessionHosts.id, hello.id));
      if (row) {
        if (!this.owns(row, caller)) throw new SessionHostError('access_denied', 'that host id belongs to someone else');
        const [updated] = await this.database.update(sessionHosts).set({ name, facts, boot: hello.boot, lastSeenAt: new Date() })
          .where(eq(sessionHosts.id, row.id)).returning();
        this.#remote.get(row.id)!.name = name;
        return updated;
      }
    }
    const [row] = await this.database.insert(sessionHosts)
      .values({ id: hello.id ?? newId(), name, ownerUserId, facts, boot: hello.boot, lastSeenAt: new Date() }).returning();
    this.#remote.set(row.id, new RemoteHost(row.id, name));
    log.info({ host: row.id, name, shared: ownerUserId === null }, 'session host registered');
    return row;
  }

  /** The host's feed opened: online, with everything unfinished re-sent.
   *  Returns the detach for when it closes. */
  async attach(id: string, caller: HostCaller, boot: string, writer: (job: Job) => void, close: () => void): Promise<() => Promise<void>> {
    const row = await this.rowFor(id, caller);
    const host = this.#remote.get(row.id)!;
    await this.database.update(sessionHosts).set({ connectedAt: new Date(), lastSeenAt: new Date(), boot }).where(eq(sessionHosts.id, id));
    // One feed per host: a new one replaces the old, which is hung up on.
    this.#feeds.get(id)?.close();
    const feed = { heard: Date.now(), close };
    this.#feeds.set(id, feed);
    host.attach(boot, writer);
    log.info({ host: id, name: row.name }, 'session host online');
    return async () => {
      if (this.#feeds.get(id) === feed) this.#feeds.delete(id);
      host.unlink(writer);
      await this.database.update(sessionHosts).set({ lastSeenAt: new Date() }).where(eq(sessionHosts.id, id)).catch(() => {});
      log.info({ host: id, name: row.name }, 'session host offline');
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

  private async rowFor(id: string, caller: HostCaller): Promise<SessionHostRow> {
    const [row] = await this.database.select().from(sessionHosts).where(eq(sessionHosts.id, id));
    if (!row || !this.#remote.has(row.id)) throw new SessionHostError('not_found', `no session host ${id}`);
    if (!this.owns(row, caller)) throw new SessionHostError('access_denied', 'access denied');
    return row;
  }

  /** The hosts a caller may see: the root API key sees all; a user sees their
   *  own and the shared ones. */
  async list(caller: HostCaller): Promise<SessionHostView[]> {
    const rows = await this.database.select().from(sessionHosts);
    const visible = rows.filter((row) => caller.admin || row.ownerUserId === null || row.ownerUserId === caller.userId);
    const counts = await this.workspaceCounts(visible.map((row) => row.id));
    return visible.map((row) => ({ ...row, online: this.#remote.get(row.id)?.online ?? false, workspaces: counts.get(row.id) ?? 0 }));
  }

  /** Forget a host: offline, and nothing pinned to it. */
  async remove(id: string, caller: HostCaller): Promise<void> {
    const row = await this.rowFor(id, caller);
    if (this.#remote.get(row.id)!.online) throw new SessionHostError('host_online', 'the host is connected — stop it first');
    if ((await this.workspaceCounts([row.id])).get(row.id)) throw new SessionHostError('host_in_use', 'workspaces are still on this host — move or delete them first');
    await this.database.delete(sessionHosts).where(eq(sessionHosts.id, row.id));
    this.#remote.delete(row.id);
  }
}
