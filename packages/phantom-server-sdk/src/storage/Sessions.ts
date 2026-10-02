// Sessions — the sessions table's one owner: the row, the record (the
// typed-line transcript), the hold a turn takes, and the bookkeeping a
// turn's start and end do. A session has a registered TYPE and one of
// three workspace relationships: it owns its checkout (workspaceId ===
// id), borrows another session's, or has none. Nothing here knows any
// particular type by name. Stub.
import type { StoredSystemPrompt, SystemPromptLayout } from 'phantom-client-sdk/systemPrompt';

export interface SessionRow {
  id: string; projectId: string; workspaceId: string | null; type: string;
  name: string | null; nameManual: boolean; status: 'active' | 'destroyed';
  planMode: boolean; pinned: boolean; archived: boolean;
  provider: string | null; model: string | null; baseUrl: string | null;
  systemPrompt: StoredSystemPrompt | null;
  turnCount: number; lastUserMessage: string | null; lastUsedAt: Date; createdAt: Date;
  lockedBy: string | null; lockedLabel: string | null; lockExpiresAt: Date | null;
  transcriptLines: number; transcriptUpdatedAt: Date | null;
}
export interface SessionListQuery {
  projectId?: string; text?: string; types?: string[]; archived?: boolean; pinnedFirst?: boolean; limit?: number; offset?: number;
}

export class Sessions {
  // ── making and ending ─────────────────────────────────────────────────
  /** A new session of `type`. `workspace`: 'own' → a checkout is made for it;
   *  a session id → it borrows that session's; null → no files. The system
   *  prompt is assembled from `layout` once, here. */
  async create(input: { projectId: string; type: string; workspace: 'own' | string | null; layout: SystemPromptLayout; id?: string }): Promise<SessionRow> { throw stub(); }
  /** Re-point a borrowing session at another session's workspace. */
  async repointWorkspace(id: string, projectId: string, borrowFromSessionId: string | null): Promise<void> { throw stub(); }
  /** A copy of a session: new row, record seeded from the source. */
  async duplicate(sourceId: string): Promise<SessionRow> { throw stub(); }
  /** Mark destroyed; files go with it when the session owns them. */
  async destroy(id: string): Promise<void> { throw stub(); }
  /** Delete the row for good. */
  async purge(id: string): Promise<void> { throw stub(); }

  // ── reading ───────────────────────────────────────────────────────────
  async get(id: string): Promise<SessionRow | undefined> { throw stub(); }
  async list(query: SessionListQuery): Promise<{ sessions: SessionRow[]; total: number }> { throw stub(); }
  /** Sessions that own a checkout still on disk. */
  async listOwningFilesOnDisk(): Promise<SessionRow[]> { throw stub(); }
  /** Sessions idle since `threshold` — the digest's input. */
  async listIdleSince(threshold: Date): Promise<SessionRow[]> { throw stub(); }
  /** Of these workspace ids, the ones some session holds a live lock on. */
  async workspacesHeld(workspaceIds: string[]): Promise<Set<string>> { throw stub(); }

  // ── the record ────────────────────────────────────────────────────────
  /** The whole transcript, or the lines after the first `after`. */
  async transcript(id: string, after?: number): Promise<string | null> { throw stub(); }
  async transcriptStamp(id: string): Promise<Date | null> { throw stub(); }
  /** Append lines, only if the record has exactly `after` lines and this
   *  deliveryId was not seen. Publishes to SessionEvents. */
  async appendTranscript(id: string, client: string, delivery: { after: number; deliveryId: string; lines: unknown[] }): Promise<{ lines: number; applied: boolean; updatedAt: Date }> { throw stub(); }
  async systemPromptOf(id: string): Promise<StoredSystemPrompt | null> { throw stub(); }
  /** Rebuild and overwrite the stored prompt (the deliberate rebuild). */
  async rewriteSystemPrompt(id: string, prompt: StoredSystemPrompt): Promise<void> { throw stub(); }

  // ── the turn ──────────────────────────────────────────────────────────
  /** Note the user's message and whether it is the session's first. */
  async turnStarted(id: string, message: string): Promise<{ firstMessage: boolean }> { throw stub(); }
  /** Bump the turn count, touch, name on cadence. */
  async turnEnded(id: string, client: string): Promise<SessionRow> { throw stub(); }
  /** Interrupt a server-run turn: abort its stream, kill its foreground commands. */
  interrupt(id: string, by: string): { interrupted: boolean } { throw stub(); }

  // ── the hold ──────────────────────────────────────────────────────────
  async acquireHold(id: string, client: string, ttlMs: number, label?: string): Promise<Date | null> { throw stub(); }
  async renewHold(id: string, client: string, ttlMs: number): Promise<Date> { throw stub(); }
  async releaseHold(id: string, client: string): Promise<boolean> { throw stub(); }
  isHeld(session: SessionRow, now?: number): boolean { throw stub(); }
  isHeldByOther(session: SessionRow, client: string): boolean { throw stub(); }

  // ── the row's small facts ─────────────────────────────────────────────
  async rename(id: string, name: string | null, by: string): Promise<void> { throw stub(); }
  async setAutoTitle(id: string, title: string): Promise<boolean> { throw stub(); }
  async setPlanMode(id: string, on: boolean): Promise<void> { throw stub(); }
  async setPinned(id: string, on: boolean): Promise<void> { throw stub(); }
  async setArchived(id: string, on: boolean): Promise<void> { throw stub(); }
  async markDigested(id: string, at: Date): Promise<void> { throw stub(); }
  async pinModel(id: string, model: { provider: string; model: string; baseUrl?: string | null }): Promise<void> { throw stub(); }
  /** Every session that has not spoken yet takes the settings' model now. */
  async followModelSettings(): Promise<void> { throw stub(); }
  async touch(id: string): Promise<void> { throw stub(); }
  ownsWorkspace(session: SessionRow): boolean { throw stub(); }
}
const stub = () => new Error('stub');
