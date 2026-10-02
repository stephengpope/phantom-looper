// Workspaces — the workspaces table's one owner: a checkout — its files
// on disk, its branch, the commit it was cut from, when it was last used,
// whether its branch reached origin, its git work state, and the sync lock.
// Its id IS its owning session's id, enforced: workspaces.id references
// sessions(id) on delete cascade. The row lives as long as the session;
// the files can be removed and restored. Stub.
export interface WorkspaceRow {
  id: string; projectId: string; branch: string; cutFromSha: string | null; onDisk: boolean;
  lastUsedAt: Date | null; lastPushedAt: Date | null; work: WorkState | null;
  syncLockHolder: string | null; syncLockExpiresAt: Date | null; createdAt: Date;
}
export type WorkState = 'clean' | 'dirty' | 'ahead' | 'merged' | 'conflict' | 'unknown';

export class Workspaces {
  async get(id: string): Promise<WorkspaceRow | undefined> { throw stub(); }
  /** Make the checkout for a session that exists: claim a warm clone or clone fresh, cut the branch, record the commit. */
  async checkout(projectId: string, ownerSessionId: string, options: { branch: string }): Promise<WorkspaceRow> { throw stub(); }
  /** Re-clone a workspace whose files were removed, on the branch the row remembers. */
  async restore(id: string): Promise<WorkspaceRow> { throw stub(); }
  /** Delete the files, keep the row. */
  async removeFiles(id: string, options?: { force?: boolean }): Promise<void> { throw stub(); }
  async countOnDisk(projectId: string): Promise<number> { throw stub(); }
  /** Activity: move lastUsedAt to now. Every tool call and turn does this. */
  async touch(id: string): Promise<void> { throw stub(); }
  /** Of these ids, the ones unused for longer than `idleMs`. */
  async listIdle(ids: string[], idleMs: number): Promise<string[]> { throw stub(); }
  async setWorkState(id: string, work: WorkState | null): Promise<void> { throw stub(); }
  async markPushed(id: string): Promise<void> { throw stub(); }
  /** Rows with a running container, for the periodic work-state refresh. */
  async listForWorkRefresh(ids: string[]): Promise<WorkspaceRow[]> { throw stub(); }
  // ── the sync lock: one git sync at a time per workspace ─────────────
  async acquireSyncLock(id: string, holder: string, ttlMs: number): Promise<boolean> { throw stub(); }
  async renewSyncLock(id: string, holder: string, ttlMs: number): Promise<void> { throw stub(); }
  async releaseSyncLock(id: string, holder: string): Promise<void> { throw stub(); }
}
const stub = () => new Error('stub');
