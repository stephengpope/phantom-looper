// The board's event bus: every card write in the system lands on the card
// routes (the cli, the Assistant's kit, the supervisor's move and tick, the
// coder's block, the looper engine itself — all HTTP clients of this one
// process), so those handlers are the one place a change is known the moment
// it happens. They publish here; `GET /workspaces/:id/events` streams it out
// as ND-JSON, and the cli's BoardStore adopts each record — the same path its
// own optimistic edits take, so a change from anywhere shows at once. One api
// process, so an in-process emitter is the whole bus; no polling anywhere.
import { EventEmitter } from 'node:events';

export type BoardEvent =
  | { event: 'card'; card: Record<string, unknown> }        // written (created or updated) — the full row
  | { event: 'deleted'; id: number }                        // hard-deleted
  | { event: 'session'; card: number; id: string; name: string | null }; // a loop paired the card with its coding session

export class BoardEvents {
  private emitter = new EventEmitter();
  constructor() { this.emitter.setMaxListeners(0); }
  publish(workspaceId: string, e: BoardEvent): void { this.emitter.emit(workspaceId, e); }
  subscribe(workspaceId: string, fn: (e: BoardEvent) => void): () => void {
    this.emitter.on(workspaceId, fn);
    return () => { this.emitter.off(workspaceId, fn); };
  }
}
