// AUTO-PULL — base into the session branch, on demand. It is `syncBranch` with
// `landOnBase: false`: the same flow as auto-push, stopping one step short.
//
// It rebases, exactly like auto-push. The reason to merge here looked good and
// was not: "a pull lands nothing on base, so a resolution buried in a merge
// commit does not matter." It does — the resolution sits on the branch and the
// next auto-push squashes and lands it. Same operation, same answer.
//
// The two things that ARE different: nothing behind means `clean`, asked before
// anything is committed so a no-op pull mints no commit and spends no model
// call; and there are no rounds, because nothing races a pull — base moving
// afterward is simply the next pull.
import type { WorkspaceRow, SessionRow } from '../db/schema.js';
import type { Paths } from '../pool/paths.js';
import type { Db } from '../db/client.js';
import { syncBranch, type SyncEvent, type SyncDeps } from './sync.js';

export type AutoPullEvent = SyncEvent;

export interface AutoPullResult {
  /** merged = base came in · clean = nothing to pull · blocked = a conflict the
   *  agent could not resolve (tree left as it was) · busy = someone else holds
   *  the session · error = git failed. */
  result: 'merged' | 'clean' | 'blocked' | 'busy' | 'error';
  reason?: string;
  /** `<short sha> <subject>` of every base commit that came in. */
  arrived?: string[];
  /** Files the replay changed in the working tree (merged only). */
  files?: string[];
  /** HEAD after the replay (merged only). */
  sha?: string;
  /** Whether the branch backup reached origin (merged only). false = the
   *  replay is in, the push is not — the result is still a sync. */
  pushed?: boolean;
}

export interface AutoPullDeps {
  db: Db;
  paths: Paths;
  encryptionKey: Buffer;
  resolve?: SyncDeps['resolve'];
  messageConfig?: SyncDeps['messageConfig'];
  onEvent?: (e: AutoPullEvent) => void | Promise<void>;
}

export async function autoPull(
  deps: AutoPullDeps, session: SessionRow, workspace: WorkspaceRow,
): Promise<AutoPullResult> {
  const r = await syncBranch(deps, session, workspace,
    { landOnBase: false, label: 'auto-pull' });
  const { reason, arrived, files, sha, pushed } = r;
  if (r.outcome === 'ok') return { result: 'merged', arrived, files, sha, pushed, ...(reason ? { reason } : {}) };
  if (r.outcome === 'nothing') return { result: 'clean' };
  return { result: r.outcome, reason };
}
