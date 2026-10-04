// This app's own routes, registered through the backend's route door
// (config.routes) under the SDK's auth and envelope: the system routes —
// this app's upgrade, logs, status, restart and token report.
import type { FastifyInstance } from 'fastify';
import type { PhantomBackend, System } from 'phantom-backend-sdk';
import { systemRoutes } from './routes/system.js';

/** What the system routes read, set when the engines start (config.onStart). */
export interface AppExtras {
  /** This backend's own housekeeping — logs, status, restart, token report. */
  system: System;
  /** Where POST /update drops a release tag for the updater sidecar. */
  updateTriggerDir?: string;
}

export const appRoutes = (api: unknown, backend: PhantomBackend, extras: AppExtras): void => {
  systemRoutes(api as FastifyInstance, backend, extras);
};
