// Periodic refresh of the workspaces' `work` column — the checkout's git state
// — for workspaces with a running container. Called every 10s from index.ts:
// recomputes workState() per workspace and writes the row when the value
// changes. A change publishes on the board event stream as `session_work`
// (named by the owning session's card) so the kanban board hears it live,
// and on the session feed through the row write.
import type { Workspaces } from '../workspaces.js';
import type { Projects } from '../projects.js';
import { workState } from './git.js';
import { repoDir, type Paths } from '../pool/paths.js';
import type { ContainerManager } from '../workspace/container.js';
import type { BoardEvents } from '../api/boardEvents.js';
import { logger, errStr } from '../log.js';

const log = logger('work-refresh');

export interface WorkRefreshDeps {
  workspaces: Workspaces; projects: Projects; paths: Paths;
  containers: ContainerManager;
  events: BoardEvents;
}

export async function refreshWorkState({ workspaces, projects, paths, containers, events }: WorkRefreshDeps): Promise<void> {
  const active = await containers.activeWorkspaces();

  // Clear stale work states: workspaces that still show a git status but whose
  // container is gone. The value is unverifiable, so null it out.
  const stale = await workspaces.listStaleWork(active);
  if (stale.length) {
    await Promise.all(stale.map(async (f) => {
      await workspaces.setWork(f.id, null);
      events.publish(f.projectId, { event: 'session_work', card: f.card ?? 0, id: f.id, work: null });
    }));
  }

  if (!active.length) return;

  const rows = await workspaces.listForWorkRefresh(active);
  if (!rows.length) return;

  // Resolve base branches per project (one lookup for the batch).
  const baseOf = new Map((await projects.list()).map((project) => [project.id, project.baseBranch]));

  // Check each workspace in parallel.
  await Promise.all(rows.map(async (f) => {
    const base = baseOf.get(f.projectId);
    if (!base) return;

    let work;
    try {
      work = await workState(repoDir(paths, f.id), f.branch, base);
    } catch (e) {
      log.warn({ workspace: f.id, err: errStr(e) }, 'could not read work state');
      return;
    }

    // Only write and publish when the value actually changed.
    if (work === f.work) return;
    // The row write publishes on the session stream too, so a window
    // watching this session sees the work-state dot update without polling.
    await workspaces.setWork(f.id, work);
    // Publish on the board stream so the kanban board picks it up.
    events.publish(f.projectId, { event: 'session_work', card: f.card ?? 0, id: f.id, work });
  }));
}
