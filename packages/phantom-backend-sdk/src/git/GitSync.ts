// GitSync — THE sync: the one flow that puts a session's work on top of
// the base branch. Auto-push lands on base; auto-pull stops one step
// short. Also the manual push / pull / status and the backup. Each step
// is an event for the session feed. Stub.
export type SyncStep = 'commit' | 'fetch' | 'rebase' | 'conflict' | 'fix' | 'push' | 'land' | 'verify' | 'done';
export interface SyncEvent { step: SyncStep; label: string; detail?: string }
export interface SyncResult { result: 'pushed' | 'nothing' | 'blocked' | 'busy'; reason?: string }

export class GitSync {
  /** Land the session's work on base. */
  async autoPush(sessionId: string, onEvent?: (event: SyncEvent) => void, by?: string): Promise<SyncResult> { throw stub(); }
  /** Bring base into the session's branch. */
  async autoPull(sessionId: string, onEvent?: (event: SyncEvent) => void, by?: string): Promise<SyncResult> { throw stub(); }
  /** Push the branch to origin as it is (the disk sweep's backup). */
  async backup(sessionId: string, whenSafe?: () => Promise<void>): Promise<SyncResult> { throw stub(); }
  async status(sessionId: string): Promise<{ branch: string; work: string; ahead: number; behind: number }> { throw stub(); }
  stepLabel(step: SyncStep, landOnBase: boolean): string { throw stub(); }
}
const stub = () => new Error('stub');
