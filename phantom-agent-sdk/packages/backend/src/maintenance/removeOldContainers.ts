// remove_old_containers — a session container that should not be running
// any more: untouched past container_idle_ms. The checkout is on the
// volume, so removal is a latency event, never a data event: the next tool
// call starts a fresh container. A container a turn holds is left alone.
import type { Settings } from '../storage/Settings.js';
import type { SessionContainers } from '../runtime/SessionContainers.js';
import type { MaintenanceJob } from './Maintenance.js';
import { logger, errStr } from '../lib/log.js';

const log = logger('container');

export function removeOldContainers(deps: {
  settings: Settings;
  sessionContainers: SessionContainers;
  /** The workspaces with a running container not touched for `idleMs` and
   *  not held by a turn — the backend's idle rule. */
  idleWorkspaces: (idleMs: number) => Promise<string[]>;
}): MaintenanceJob {
  return {
    name: 'remove_old_containers',
    description: 'Removes a session container untouched past container_idle_ms, unless a turn holds it. The checkout stays; the next tool call starts a fresh container.',
    where: 'session runners',
    async run() {
      const idleMs = Number(await deps.settings.resolve('container_idle_ms'));
      let removed = 0, failed = 0;
      for (const workspaceId of await deps.idleWorkspaces(idleMs)) {
        try {
          await deps.sessionContainers.remove(workspaceId);
          removed++;
          log.info({ workspace: workspaceId }, 'idle workspace container removed');
        } catch (error) {
          failed++;
          log.warn({ workspace: workspaceId, err: errStr(error) }, 'idle workspace container could not be removed');
        }
      }
      return { removed, failed };
    },
  };
}
