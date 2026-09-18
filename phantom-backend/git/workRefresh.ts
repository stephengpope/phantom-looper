// Periodic refresh of the folders' `work` column — the checkout's git state
// — for folders with a running container. Called every 10s from index.ts:
// recomputes workState() per folder and writes the row when the value
// changes. A change publishes on the board event stream as `session_work`
// (named by the owning session's card) so the kanban board hears it live,
// and on the session feed through the row write.
import type { Folders } from '../folders.js';
import type { Workspaces } from '../workspaces.js';
import { workState } from './git.js';
import { repoDir, type Paths } from '../pool/paths.js';
import type { ContainerManager } from '../workspace/container.js';
import type { BoardEvents } from '../api/boardEvents.js';
import { logger, errStr } from '../log.js';

const log = logger('work-refresh');

export interface WorkRefreshDeps {
  folders: Folders; workspaces: Workspaces; paths: Paths;
  containers: ContainerManager;
  events: BoardEvents;
}

export async function refreshWorkState({ folders, workspaces, paths, containers, events }: WorkRefreshDeps): Promise<void> {
  const active = await containers.activeFolders();

  // Clear stale work states: folders that still show a git status but whose
  // container is gone. The value is unverifiable, so null it out.
  const stale = await folders.listStaleWork(active);
  if (stale.length) {
    await Promise.all(stale.map(async (f) => {
      await folders.setWork(f.id, null);
      events.publish(f.workspaceId, { event: 'session_work', card: f.card ?? 0, id: f.id, work: null });
    }));
  }

  if (!active.length) return;

  const rows = await folders.listForWorkRefresh(active);
  if (!rows.length) return;

  // Resolve base branches per workspace (one lookup for the batch).
  const baseOf = new Map((await workspaces.list()).map((w) => [w.id, w.baseBranch]));

  // Check each folder in parallel.
  await Promise.all(rows.map(async (f) => {
    const base = baseOf.get(f.workspaceId);
    if (!base) return;

    let work;
    try {
      work = await workState(repoDir(paths, f.id), f.branch, base);
    } catch (e) {
      log.warn({ folder: f.id, err: errStr(e) }, 'could not read work state');
      return;
    }

    // Only write and publish when the value actually changed.
    if (work === f.work) return;
    // The row write publishes on the session stream too, so a window
    // watching this session sees the work-state dot update without polling.
    await folders.setWork(f.id, work);
    // Publish on the board stream so the kanban board picks it up.
    events.publish(f.workspaceId, { event: 'session_work', card: f.card ?? 0, id: f.id, work });
  }));
}
