// remove_old_containers — a session container that should not be running
// any more, for either of two reasons:
//
//   idle      untouched past container_idle_ms;
//   outdated  not on the image its project's settings say now — after a
//             release moved the default, or a project changed its own.
//
// The checkout is on the volume, so removal is a latency event, never a
// data event: the next tool call starts a fresh container, on the current
// image. A container a turn holds is left alone either way, and taken on
// a later run. A runner that does not say what image a container runs (a
// release before this rule) is left to the idle rule alone.
import type { Settings } from '../storage/Settings.js';
import type { Workspaces } from '../storage/Workspaces.js';
import type { Projects } from '../storage/Projects.js';
import type { ProjectRow } from '../storage/schema.js';
import type { SessionContainers } from '../runtime/SessionContainers.js';
import type { MaintenanceJob } from './Maintenance.js';
import { scopeOf } from '../lib/scopes.js';
import { logger, errStr } from '../lib/log.js';

const log = logger('container');

export function removeOldContainers(deps: {
  settings: Settings;
  workspaces: Workspaces;
  projects: Projects;
  sessionContainers: SessionContainers;
  /** Of these workspace ids, the ones a turn holds — never removed. */
  busy: (workspaceIds: string[]) => Promise<Set<string>>;
}): MaintenanceJob {
  return {
    name: 'remove_old_containers',
    description: 'Removes a session container untouched past container_idle_ms, or running an image other than the one its project\'s settings say now — unless a turn holds it. The checkout stays; the next tool call starts a fresh container.',
    where: 'session runners',
    async run() {
      const idleMs = Number(await deps.settings.resolve('container_idle_ms'));
      const active = await deps.sessionContainers.activeContainers();
      const idle = new Set(await deps.workspaces.listIdle(active.map((container) => container.workspaceId), idleMs));

      // The image each project's settings name now, read once per project.
      const projects = new Map<string, Promise<ProjectRow | undefined>>();
      const images = new Map<string, Promise<string>>();
      const currentImage = async (workspaceId: string): Promise<string | null> => {
        const workspace = await deps.workspaces.get(workspaceId);
        if (!workspace) return null;
        const { projectId } = workspace;
        if (!projects.has(projectId)) projects.set(projectId, deps.projects.get(projectId));
        const project = await projects.get(projectId)!;
        if (!project) return null;
        if (!images.has(projectId)) images.set(projectId, deps.settings.resolve<string>('container_image', scopeOf(project)).then(String));
        return images.get(projectId)!;
      };
      const outdated = new Set<string>();
      for (const container of active) {
        if (!container.image || idle.has(container.workspaceId)) continue;
        const current = await currentImage(container.workspaceId);
        if (current && container.image !== current) outdated.add(container.workspaceId);
      }

      const candidates = [...new Set([...idle, ...outdated])];
      const busy = await deps.busy(candidates);
      let removed = 0, failed = 0, held = 0;
      for (const workspaceId of candidates) {
        if (busy.has(workspaceId)) { held++; continue; }
        const why = idle.has(workspaceId) ? 'idle' : 'outdated';
        try {
          await deps.sessionContainers.remove(workspaceId);
          removed++;
          log.info({ workspace: workspaceId, why }, 'workspace container removed');
        } catch (error) {
          failed++;
          log.warn({ workspace: workspaceId, why, err: errStr(error) }, 'workspace container could not be removed');
        }
      }
      return { removed, held, failed };
    },
  };
}
