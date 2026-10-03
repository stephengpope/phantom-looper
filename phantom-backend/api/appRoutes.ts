// This app's own routes and the extras they read, registered through the
// backend's route door (HttpApi.addRoutes) under the SDK's auth and
// envelope. Each extra is transitional — it leaves with the plan step named
// on it (docs/phantom-agent-sdk-plan.md).
import type { FastifyInstance } from 'fastify';
import type { PhantomBackend } from 'phantom-backend-sdk';
import type { SessionRow, ProjectRow } from 'phantom-backend-sdk/schema';
import type { System } from '../system.js';
import type { GitSync, AutoPushResult, AutoPushEvent, AutoPullResult, AutoPullEvent } from 'phantom-backend-sdk';
import { gitRoutes } from './routes/git.js';
import { systemRoutes } from './routes/system.js';
import { telegramRoutes } from './routes/telegram.js';
import { turnRoute } from './routes/turn.js';

export interface AppExtras {
  apiKey: string;
  /** The manual git operations and the two auto syncs. → GitSync (§4). */
  engine: GitSync;
  autoPush: (session: SessionRow, project: ProjectRow,
    onEvent?: (e: AutoPushEvent) => void | Promise<void>, by?: string) => Promise<AutoPushResult>;
  autoPull: (session: SessionRow, project: ProjectRow,
    onEvent?: (e: AutoPullEvent) => void | Promise<void>, by?: string) => Promise<AutoPullResult>;
  /** This backend's own housekeeping — logs, status, restart, token report. → Upgrader. */
  system: System;
  /** Where POST /update drops a release tag for the updater sidecar. → Upgrader. */
  updateTriggerDir?: string;
  /** Test seam: the fetch MODEL calls use. Goes with core/llm (§7). */
  modelFetch?: typeof fetch;
  /** The Telegram engine — set after listen. → TelegramApi.onUpdate (§6). */
  telegram?: {
    handleUpdate(secretHeader: string, update: unknown): Promise<number>;
    reconcile(): Promise<void>;
  };
}

/** The app's routes, for `config.routes`. */
export const appRoutes = (backend: PhantomBackend, extras: AppExtras) => (api: unknown): void => {
  const app = api as FastifyInstance;
  turnRoute(app, backend, extras);
  gitRoutes(app, backend, extras);
  systemRoutes(app, backend, extras);
  telegramRoutes(app, backend, extras);
};
