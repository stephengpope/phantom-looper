// The board's event bus: every card write in the system lands on the card
// routes (the cli, the Assistant's kit, the supervisor's move and tick, the
// coder's block, the looper engine itself — all HTTP clients of this one
// process), so those handlers are the one place a change is known the moment
// it happens. They publish here; `GET /projects/:id/events` streams it out
// as ND-JSON, and the cli's BoardStore adopts each record — the same path its
// own optimistic edits take, so a change from anywhere shows at once. One api
// process, so an in-process emitter is the whole bus; no polling anywhere.
import { EventEmitter } from 'node:events';

/** The all-projects channel; a symbol so no project id can collide with it. */
const ALL = Symbol('all');

export type BoardEvent =
  // written (created or updated) — the full row. `from` is the status BEFORE
  // the write (absent on create, and on the auto-push-failure un-archive),
  // `client` the writer's x-phantom-looper-client — together they let a
  // listener tell a MOVE by the loop from an edit by a person without
  // remembering anything. The cli's BoardStore reads `card` only.
  | { event: 'card'; card: Record<string, unknown>; from?: string; client?: string;
      /** Whether the card was archived BEFORE this write — with `card.archived`,
       *  the false → true transition the archive auto-push listens for. */
      archivedBefore?: boolean }
  | { event: 'deleted'; id: number }                        // hard-deleted
  // One event type per fact, each complete — no field is ever a placeholder
  // for a fact the publisher does not own (the per-session feed's rule,
  // sessionEvents.ts).
  | { event: 'session'; card: number; id: string; name: string | null } // a loop paired the card with its coding session — the ONE speaker for the card→session pairing and its name
  | { event: 'session_lock'; card: number; id: string; locked: boolean } // the card's coding session hold changed
  | { event: 'session_work_state'; card: number; id: string; workState: string | null }; // the card's git state changed

export class BoardEvents {
  private emitter = new EventEmitter();
  constructor() { this.emitter.setMaxListeners(0); }
  publish(projectId: string, e: BoardEvent): void {
    this.emitter.emit(projectId, e);
    this.emitter.emit(ALL, projectId, e);
  }
  subscribe(projectId: string, fn: (e: BoardEvent) => void): () => void {
    this.emitter.on(projectId, fn);
    return () => { this.emitter.off(projectId, fn); };
  }
  /** Every project's events, tagged with the project — the Telegram
   *  alerts listen here. Events are keyed by project id, so `publish` also
   *  emits on ALL. */
  subscribeAll(fn: (projectId: string, e: BoardEvent) => void): () => void {
    this.emitter.on(ALL, fn);
    return () => { this.emitter.off(ALL, fn); };
  }
}
