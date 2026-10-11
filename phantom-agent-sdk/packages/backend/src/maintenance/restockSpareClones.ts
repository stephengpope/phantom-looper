// restock_spare_clones — the warm checkouts: the facts resolved once here,
// the tick run on every online session runner as a job (a slow clone there
// never holds this loop, and the runner drops a tick under a running one). A
// runner is stocked only for projects that have had a workspace on it.
import type { Projects } from '../storage/Projects.js';
import type { Settings } from '../storage/Settings.js';
import type { Runners } from '../host/Runners.js';
import * as checkoutPool from '../runtime/CheckoutPool.js';
import type { MaintenanceJob } from './Maintenance.js';
import { logger, errStr } from '../lib/log.js';

const log = logger('pool');

export function restockSpareClones(deps: { projects: Projects; settings: Settings; runners: Runners }): MaintenanceJob {
  return {
    name: 'restock_spare_clones',
    description: 'Keeps each project\'s spare_clones warm checkouts ready on every session runner that has served it; a dead clone and a slot for a project no longer served are removed.',
    where: 'session runners',
    async run() {
      const pool = await checkoutPool.poolFacts(deps.projects, deps.settings);
      if (!pool) return { runners: 0 };
      let runners = 0;
      for (const runner of deps.runners.onlineRunners()) {
        const served = await deps.runners.projectsOn(runner.id).catch(() => new Set<string>());
        const mine = pool.filter((project) => served.has(project.id));
        if (!mine.length) continue;
        runners++;
        void runner.poolTick(mine).catch((error) => log.warn({ runner: runner.name, err: errStr(error) }, 'pool tick on runner failed'));
      }
      return { runners };
    },
  };
}
