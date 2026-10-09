// Periodic refresh of the workspaces' `work` column — the checkout's git state
// — for workspaces with a running container. Called every 10s from index.ts:
// recomputes workState() per workspace and writes the row when the value
// changes. A change publishes on the board event stream as `session_work`
// (named by the owning session's card) so the kanban board hears it live,
// and on the session feed through the row write.
import type { Workspaces } from '../storage/Workspaces.js';
import type { Projects } from '../storage/Projects.js';
import { workState } from './Git.js';
import type { SessionHosts } from '../host/SessionHosts.js';
import type { SessionContainers } from '../runtime/SessionContainers.js';
import type { BoardEvents } from '../agents/BoardEvents.js';
import { logger, errStr } from '../lib/log.js';

const log = logger('work-refresh');

export interface WorkRefreshDeps {
  workspaces: Workspaces; projects: Projects; hosts: SessionHosts;
  sessionContainers: SessionContainers;
  boardEvents: BoardEvents;
}

export async function refreshWorkState({ workspaces, projects, hosts, sessionContainers, boardEvents }: WorkRefreshDeps): Promise<void> {
  const active = await sessionContainers.activeWorkspaces();

  // Clear stale work states: workspaces that still show a git status but whose
  // container is gone. The value is unverifiable, so null it out.
  const stale = await workspaces.listStaleWork(active);
  if (stale.length) {
    await Promise.all(stale.map(async (workspace) => {
      await workspaces.setWorkState(workspace.id, null);
      boardEvents.publish(workspace.projectId, { event: 'session_work_state', card: workspace.card ?? 0, id: workspace.id, workState: null });
    }));
  }

  if (!active.length) return;

  const rows = await workspaces.listForWorkRefresh(active);
  if (!rows.length) return;

  // Resolve base branches per project (one lookup for the batch).
  const baseOf = new Map((await projects.list()).map((project) => [project.id, project.baseBranch]));

  // Check each workspace in parallel.
  await Promise.all(rows.map(async (workspace) => {
    const base = baseOf.get(workspace.projectId);
    if (!base) return;

    let work;
    try {
      const host = await hosts.of(workspace.id);
      if (!host.online) return;   // unreadable right now; measured again next tick
      work = await workState(host.repo(workspace.id), workspace.branch, base);
    } catch (error) {
      log.warn({ workspace: workspace.id, err: errStr(error) }, 'could not read work state');
      return;
    }

    // Only write and publish when the value actually changed.
    if (work === workspace.workState) return;
    // The row write publishes on the session stream too, so a window
    // watching this session sees the work-state dot update without polling.
    await workspaces.setWorkState(workspace.id, work);
    // Publish on the board stream so the kanban board picks it up.
    boardEvents.publish(workspace.projectId, { event: 'session_work_state', card: workspace.card ?? 0, id: workspace.id, workState: work });
  }));
}
