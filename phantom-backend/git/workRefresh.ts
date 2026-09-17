// Periodic refresh of the `work` column on sessions with an active container.
// Called every 10s from index.ts. For each session the container manager
// tracks, recomputes workState() and writes the row when the value changes.
// A change publishes on the board event stream as `session_work` so the
// kanban board hears it live.
import type { Sessions } from '../sessions.js';
import type { Workspaces } from '../workspaces.js';
import type { Folders } from '../folders.js';
import { workState, type WorkState } from './git.js';
import { repoDir, type Paths } from '../pool/paths.js';
import type { ContainerManager } from '../workspace/container.js';
import type { BoardEvents } from '../api/boardEvents.js';
import { logger, errStr } from '../log.js';

const log = logger('work-refresh');

export interface WorkRefreshDeps {
  sessions: Sessions; workspaces: Workspaces; folders: Folders; paths: Paths;
  containers: ContainerManager;
  events: BoardEvents;
}

export async function refreshWorkState({ sessions, workspaces, folders, paths, containers, events }: WorkRefreshDeps): Promise<void> {
  const active = await containers.activeSessions();

  // Clear stale work states: sessions that still show a git status but whose
  // container is gone. The value is unverifiable, so null it out.
  const stale = await sessions.listStaleWork(active);
  if (stale.length) {
    await Promise.all(stale.map(async (r) => {
      await sessions.setWork(r.id, null);
      events.publish(r.workspaceId, { event: 'session_work', card: r.card ?? 0, id: r.id, work: null });
    }));
  }

  if (!active.length) return;

  // Load the session rows that have containers. Only active sessions with a
  // folder (a checkout on disk) can have a work state.
  const rows = await sessions.listForWorkRefresh(active);

  if (!rows.length) return;

  // Resolve base branches per workspace (one lookup for the batch).
  const baseOf = new Map((await workspaces.list()).map((w) => [w.id, w.baseBranch]));

  // Resolve branches per folder.
  const branchOf = await folders.branchesOf(rows.map((r) => r.folderId).filter((f): f is string => f !== null));

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
    // The row write publishes on the session stream too, so a window
    // watching this session sees the work-state dot update without polling.
    await sessions.setWork(r.id, work);
    // Publish on the board stream so the kanban board picks it up.
    const card = r.card ?? 0;
    events.publish(r.workspaceId, { event: 'session_work', card, id: r.id, work });
  }));
}
