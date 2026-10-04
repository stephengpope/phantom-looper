// Periodic refresh of the workspaces' `work` column — the checkout's git state
// — for workspaces with a running container. Called every 10s from index.ts:
// recomputes workState() per workspace and writes the row when the value
// changes. A change publishes on the board event stream as `session_work`
// (named by the owning session's card) so the kanban board hears it live,
// and on the session feed through the row write.
import type { Workspaces } from '../storage/Workspaces.js';
import type { Projects } from '../storage/Projects.js';
import { workState } from './Git.js';
import { repoDir, type Paths } from '../lib/paths.js';
import type { SessionContainers } from '../runtime/SessionContainers.js';
import type { BoardEvents } from '../agents/BoardEvents.js';
import { logger, errStr } from '../lib/log.js';

const log = logger('work-refresh');

export interface WorkRefreshDeps {
  workspaces: Workspaces; projects: Projects; paths: Paths;
  sessionContainers: SessionContainers;
  boardEvents: BoardEvents;
}

export async function refreshWorkState({ workspaces, projects, paths, sessionContainers, boardEvents }: WorkRefreshDeps): Promise<void> {
  const active = await sessionContainers.activeWorkspaces();

  // Clear stale work states: workspaces that still show a git status but whose
  // container is gone. The value is unverifiable, so null it out.
  const stale = await workspaces.listStaleWork(active);
  if (stale.length) {
    await Promise.all(stale.map(async (f) => {
      await workspaces.setWorkState(f.id, null);
      boardEvents.publish(f.projectId, { event: 'session_work_state', card: f.card ?? 0, id: f.id, workState: null });
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
    if (work === f.workState) return;
    // The row write publishes on the session stream too, so a window
    // watching this session sees the work-state dot update without polling.
    await workspaces.setWorkState(f.id, work);
    // Publish on the board stream so the kanban board picks it up.
    boardEvents.publish(f.projectId, { event: 'session_work_state', card: f.card ?? 0, id: f.id, workState: work });
  }));
}
