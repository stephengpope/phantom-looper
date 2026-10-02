// SessionEvents — one session's live traffic: the parts of a turn as they
// stream, the record landing, the hold changing, an interrupt, plan mode
// flipping. A publisher never hears itself. Stub.
export type SessionEvent = { event: string } & Record<string, unknown>;

export class SessionEvents {
  publish(sessionId: string, by: string, event: SessionEvent): void { throw stub(); }
  /** A model-stream part, capped to CAP_BYTES. */
  publishPart(sessionId: string, by: string, part: unknown): void { throw stub(); }
  subscribe(sessionId: string, listener: (event: SessionEvent, by: string) => void): () => void { throw stub(); }
  subscribeAll(listener: (sessionId: string, event: SessionEvent, by: string) => void): () => void { throw stub(); }
}
const stub = () => new Error('stub');
