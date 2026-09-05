// The board's event bus: every card write in the system lands on the card
// routes (the cli, the Assistant's kit, the supervisor's move and tick, the
// coder's block, the looper engine itself — all HTTP clients of this one
// process), so those handlers are the one place a change is known the moment
// it happens. They publish here; `GET /workspaces/:id/events` streams it out
// as ND-JSON, and the cli's BoardStore adopts each record — the same path its
// own optimistic edits take, so a change from anywhere shows at once. One api
// process, so an in-process emitter is the whole bus; no polling anywhere.
import { EventEmitter } from 'node:events';

/** The all-workspaces channel; a symbol so no workspace id can collide with it. */
const ALL = Symbol('all');

export type BoardEvent =
  // written (created or updated) — the full row. `from` is the status BEFORE
  // the write (absent on create, and on the auto-push-failure un-archive),
  // `client` the writer's x-phantom-looper-client — together they let a
  // listener tell a MOVE by the loop from an edit by a person without
  // remembering anything. The cli's BoardStore reads `card` only.
  | { event: 'card'; card: Record<string, unknown>; from?: string; client?: string }
  | { event: 'deleted'; id: number }                        // hard-deleted
  | { event: 'session'; card: number; id: string; name: string | null }; // a loop paired the card with its coding session

export class BoardEvents {
  private emitter = new EventEmitter();
  constructor() { this.emitter.setMaxListeners(0); }
  publish(workspaceId: string, e: BoardEvent): void {
    this.emitter.emit(workspaceId, e);
    this.emitter.emit(ALL, workspaceId, e);
  }
  subscribe(workspaceId: string, fn: (e: BoardEvent) => void): () => void {
    this.emitter.on(workspaceId, fn);
    return () => { this.emitter.off(workspaceId, fn); };
  }
  /** Every workspace's events, tagged with the workspace — the Telegram
   *  alerts listen here. Events are keyed by workspace id, so `publish` also
   *  emits on ALL. */
  subscribeAll(fn: (workspaceId: string, e: BoardEvent) => void): () => void {
    this.emitter.on(ALL, fn);
    return () => { this.emitter.off(ALL, fn); };
  }
}
