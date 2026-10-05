// This app's own routes, registered through the backend's route door
// (config.routes) under /app and the SDK's envelope: the system routes —
// this app's upgrade, logs, status, restart and token report. The SDK puts
// no key check on /app; this app admits the operator alone, as before.
import type { FastifyInstance } from 'fastify';
import type { PhantomBackend, Deployment } from '@phantom-agent-sdk/backend';
import { systemRoutes } from './routes/system.js';

/** What the system routes read, set when the engines start (config.onStart). */
export interface AppExtras {
  /** This backend's own housekeeping — logs, status, restart, token report. */
  deployment: Deployment;
  /** Where POST /update drops a release tag for the updater sidecar. */
  updateTriggerDir?: string;
}

export const appRoutes = (api: unknown, backend: PhantomBackend, extras: AppExtras): void => {
  const app = api as FastifyInstance;
  app.addHook('onRequest', async (request) => { await backend.identity.require(request); });
  systemRoutes(app, backend, extras);
};
