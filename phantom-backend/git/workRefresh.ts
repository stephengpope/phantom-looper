// Periodic refresh of the `work` column on sessions with an active container.
// Called every 10s from index.ts. For each session the container manager
// tracks, recomputes workState() and writes the row when the value changes.
// A change publishes on the board event stream so the kanban board hears it
// live (the `session` event type already carries card ↔ session facts).
import { eq, and, inArray, desc } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions, workspaces, folders, loops } from '../db/schema.js';
import { workState, type WorkState } from './git.js';
import { repoDir, type Paths } from '../pool/paths.js';
import type { ContainerManager } from '../workspace/container.js';
import type { BoardEvents } from '../api/boardEvents.js';
import type { SessionEvents } from '../api/sessionEvents.js';
import { logger, errStr } from '../log.js';

const log = logger('work-refresh');

export interface WorkRefreshDeps {
  db: Db; paths: Paths;
  containers: ContainerManager;
  events: BoardEvents;
  /** The same feed used by lock and turn publishers; absent for board-only callers. */
  sessionEvents?: SessionEvents;
}

export async function refreshWorkState({ db, paths, containers, events, sessionEvents }: WorkRefreshDeps): Promise<void> {
  const active = containers.activeSessions();
  if (!active.length) return;

  // Load the session rows that have containers. Only active sessions with a
  // folder (a checkout on disk) can have a work state.
  const rows = await db.select({
    id: sessions.id, folderId: sessions.folderId,
    workspaceId: sessions.workspaceId, work: sessions.work,
  }).from(sessions).where(and(inArray(sessions.id, active)));

  if (!rows.length) return;

  // Resolve base branches per workspace (one lookup for the batch).
  const wsIds = [...new Set(rows.map((r) => r.workspaceId))];
  const wsRows = await db.select({ id: workspaces.id, baseBranch: workspaces.baseBranch })
    .from(workspaces).where(inArray(workspaces.id, wsIds));
  const baseOf = new Map(wsRows.map((w) => [w.id, w.baseBranch]));

  // Resolve branches per folder.
  const folderIds = rows.map((r) => r.folderId).filter((f): f is string => f !== null);
  const folderRows = folderIds.length
    ? await db.select({ id: folders.id, branch: folders.branch }).from(folders)
        .where(inArray(folders.id, folderIds))
    : [];
  const branchOf = new Map(folderRows.map((f) => [f.id, f.branch]));

  // Look up card ↔ session pairings for publishing (the board event needs the
  // card number so the board store can map it). One query for the batch.
  const loopRows = await db.select({ card: loops.card, codingSessionId: loops.codingSessionId })
    .from(loops).where(inArray(loops.codingSessionId, rows.map((r) => r.id)));
  const cardOf = new Map<string, number>();
  for (const l of loopRows) cardOf.set(l.codingSessionId, l.card);

  // Check each session in parallel.
  await Promise.all(rows.map(async (r) => {
    if (!r.folderId) return;
    const base = baseOf.get(r.workspaceId);
    const branch = branchOf.get(r.folderId);
    if (!base || !branch) return;

    let work: WorkState | null;
    try {
      work = await workState(repoDir(paths, r.folderId), branch, base);
    } catch (e) {
      log.warn({ session: r.id, err: errStr(e) }, 'could not read work state');
      return;
    }

    // Only write and publish when the value actually changed.
    if (work === r.work) return;
    await db.update(sessions).set({ work }).where(eq(sessions.id, r.id));
    // Publish on the board stream so the kanban board picks it up.
    const card = cardOf.get(r.id) ?? 0;
    events.publish(r.workspaceId, { event: 'session', card, id: r.id, name: null, work });
    // Publish on the session stream so a window watching this session
    // sees the work-state dot update without polling.
    sessionEvents?.publish(r.id, '', { event: 'session', work });
  }));
}
