// AUTO-PUSH — the ONE way a session's work reaches the base branch. It is
// `syncBranch` with `landOnBase: true`; sync.ts holds the flow and the whole
// argument for it. This file is the result vocabulary the routes and the app
// already speak, and nothing else.
import type { ProjectRow, SessionRow } from '../storage/schema.js';
import type { Paths } from '../lib/paths.js';
import { syncBranch, type SyncEvent, type SyncDeps } from './sync.js';
import type { Sessions } from '../storage/Sessions.js';
import type { Workspaces } from '../storage/Workspaces.js';
import type { Cards } from '../storage/Cards.js';
import type { Settings } from '../storage/Settings.js';

export { LOCK_TTL_MS, RENEW_MS, type ConflictContext } from './sync.js';

export type AutoPushEvent = SyncEvent;

export interface AutoPushResult {
  result: 'pushed' | 'nothing' | 'blocked' | 'busy' | 'error';
  reason?: string;
  rounds?: number;
  /** The commit that landed on base (pushed only). */
  sha?: string;
}

export interface AutoPushDeps {
  sessions: Sessions;
  workspaces: Workspaces;
  cards: Cards;
  settings: Settings;
  paths: Paths;
  resolve?: SyncDeps['resolve'];
  recordSummary?: SyncDeps['recordSummary'];
  writeCommitMessage?: SyncDeps['writeCommitMessage'];
  onEvent?: (event: AutoPushEvent) => void | Promise<void>;
}

export async function autoPush(
  deps: AutoPushDeps, session: SessionRow, project: ProjectRow,
  /** `hold: false` — run without taking the session (instant sync; see sync.ts). */
  opts: { hold?: boolean } = {},
): Promise<AutoPushResult> {
  const synced = await syncBranch(deps, session, project,
    { landOnBase: true, label: 'auto-push', ...opts });
  const { reason, rounds, sha } = synced;
  if (synced.outcome === 'ok') return { result: 'pushed', rounds, sha };
  return { result: synced.outcome === 'nothing' ? 'nothing' : synced.outcome, reason, rounds };
}

// Re-exported so callers that only import autoPush keep type access.
