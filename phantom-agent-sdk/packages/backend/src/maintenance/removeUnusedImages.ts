// remove_unused_images — release images no container uses any more. A
// release pulls a new tag of the api image and the session image on every
// box, and nothing else ever removes the old ones; a container pins its
// image until it is gone (remove_old_containers). On every box that can
// answer — this server's own, and each online session runner — the tags of
// releases older than the ones in use go. Images.ts owns the rule: never a
// newer tag (an update in flight pulled it), never `latest`, nothing while
// a pull is in flight.
import { API_IMAGE, APP_VERSION } from '../lib/env.js';
import type { Settings } from '../storage/Settings.js';
import type { Runners } from '../host/Runners.js';
import type { MaintenanceJob } from './Maintenance.js';
import { logger, errStr } from '../lib/log.js';

const log = logger('images');

/** The api's own image at its current tag — handed in by compose (a container
 *  cannot name its own image). The tag rule is the same one settings.ts uses
 *  for the session image default: a release version is its own tag, anything
 *  else tracks latest. A wrong guess here is harmless: an image a container
 *  uses is never removed. */
const API_IMAGE_CURRENT = `${API_IMAGE}:${/^v\d+\.\d+\.\d+/.test(APP_VERSION) ? APP_VERSION : 'latest'}`;

/** The images in use: the session image the settings name, and this api's own. */
export async function currentImages(settings: Settings): Promise<string[]> {
  return [String(await settings.resolve('container_image')), API_IMAGE_CURRENT];
}

export function removeUnusedImages(deps: { settings: Settings; runners: Runners }): MaintenanceJob {
  return {
    name: 'remove_unused_images',
    description: 'Deletes release images older than the ones in use that no container uses any more, on this server and every online session runner.',
    where: 'api and session runners',
    async run() {
      const currents = await currentImages(deps.settings);
      const boxes = [deps.runners.local, ...deps.runners.onlineRunners()];
      let removed = 0;
      for (const box of boxes) {
        removed += await box.removeOldImages(currents)
          .catch((error) => { log.warn({ box: box.name, err: errStr(error) }, 'image cleanup failed'); return 0; });
      }
      return { boxes: boxes.length, removed };
    },
  };
}
