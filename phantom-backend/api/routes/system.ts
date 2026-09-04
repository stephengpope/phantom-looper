// Server-level operations. Today: the remote upgrade.
//
// POST /update {tag} drops the requested release tag where the updater
// sidecar polls for it (UPDATE_TRIGGER_DIR, a volume shared with the `updater`
// compose service). The sidecar pulls that tag's images, refreshes the host
// files out of the api image, pins the tag in .env and recreates the stack —
// see updater/. This process never touches docker for that: it only sees the
// socket proxy, which refuses everything compose needs, and that is the point
// (the thing holding the real socket has no network surface). The route
// returns as soon as the trigger is written; the restart that follows is the
// observable result (GET /health's version changes).
import type { FastifyInstance } from 'fastify';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AppCtx } from '../app.js';
import { err, ok } from '../app.js';
import { logger, errStr } from '../../log.js';

const log = logger('system');

export const RELEASE_TAG = /^v\d+\.\d+\.\d+$/;

export function systemRoutes(app: FastifyInstance, ctx: AppCtx) {
  app.post('/update', {
    schema: {
      tags: ['meta'],
      summary: 'Upgrade this server to a release',
      description: 'Hands a release tag to the updater sidecar, which pulls that version\'s images, ' +
        'refreshes the deploy files on the host from the image, and recreates the stack. Returns as soon as ' +
        'the request is handed over — the upgrade itself takes a minute or two, during which the API ' +
        'restarts (in-flight bash commands are cut off; sessions resume on their next call). ' +
        'Watch GET /health `version` change. `updater_unavailable` (503) means this server was started ' +
        'without the sidecar (a dev `docker compose up`, or an install older than it): re-run install.sh once.',
      body: {
        type: 'object', required: ['tag'], additionalProperties: false,
        properties: {
          tag: { type: 'string', pattern: RELEASE_TAG.source, description: 'Release tag, e.g. v0.2.0 (no prereleases)' },
        },
      },
    },
  }, async (req, reply) => {
    const { tag } = req.body as { tag: string };
    if (!ctx.updateTriggerDir) {
      return reply.code(503).send(err('updater_unavailable', 'this server has no updater sidecar (UPDATE_TRIGGER_DIR unset) — re-run install.sh once'));
    }
    try {
      await fs.writeFile(path.join(ctx.updateTriggerDir, 'request'), `${tag}\n`);
    } catch (e) {
      log.error({ err: errStr(e), tag }, 'update trigger failed');
      return reply.code(503).send(err('updater_unavailable', `could not hand the request to the updater: ${errStr(e)}`));
    }
    log.info({ tag }, 'update requested');
    return ok({ tag, requested: true });
  });
}
