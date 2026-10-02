// SessionTitler — names a session from its first user messages, with a
// model, on a cadence (first message, then every N turns until a person
// names it). Best effort, fire-and-forget, never in a save path. Stub.
export class SessionTitler {
  /** Should this session be (re)named now? */
  isDue(name: string | null, turnCount: number): boolean { throw stub(); }
  /** Read the record, ask the model, write the auto title. Swallows failure. */
  async name(sessionId: string): Promise<void> { throw stub(); }
}
const stub = () => new Error('stub');
