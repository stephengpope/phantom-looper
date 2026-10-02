// UserMessageQueue — one-liners the server holds for a session's NEXT turn
// (a detached command exited, a dropped file landed, a sync pulled).
// turn-start drains them into the record under the hold, ahead of the
// user's words. In memory: the fact each reports lives in its own row. A
// text already waiting for the session is not queued twice. Stub.
export class UserMessageQueue {
  add(sessionId: string, text: string): void { throw stub(); }
  pending(sessionId: string): readonly string[] { throw stub(); }
  /** Take everything waiting, in order. The caller writes them. */
  take(sessionId: string): string[] { throw stub(); }
  /** Put taken messages back, ahead of anything newer, when the write failed. */
  restore(sessionId: string, texts: string[]): void { throw stub(); }
}
const stub = () => new Error('stub');
