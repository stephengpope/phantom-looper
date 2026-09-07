// AUTO-PUSH — the ONE way a session's work reaches the base branch. It is
// `syncBranch` with `landOnBase: true`; sync.ts holds the flow and the whole
// argument for it. This file is the result vocabulary the routes and the app
// already speak, and nothing else.
import type { WorkspaceRow, SessionRow } from '../db/schema.js';
import type { Paths } from '../pool/paths.js';
import type { Db } from '../db/client.js';
import type { ModelConfig } from '../../core/llm/createAgent.js';
import { syncBranch, type SyncEvent, type SyncDeps, type ConflictContext } from './sync.js';

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
  db: Db;
  paths: Paths;
  encryptionKey: Buffer;
  resolve?: SyncDeps['resolve'];
  recordSummary?: SyncDeps['recordSummary'];
  messageConfig?: SyncDeps['messageConfig'];
  onEvent?: (e: AutoPushEvent) => void | Promise<void>;
}

export async function autoPush(
  deps: AutoPushDeps, session: SessionRow, workspace: WorkspaceRow,
): Promise<AutoPushResult> {
  const r = await syncBranch(deps, session, workspace,
    { landOnBase: true, label: 'auto-push' });
  const { reason, rounds, sha } = r;
  if (r.outcome === 'ok') return { result: 'pushed', rounds, sha };
  return { result: r.outcome === 'nothing' ? 'nothing' : r.outcome, reason, rounds };
}

// Re-exported so callers that only import autoPush keep type access.
export type { ModelConfig };
