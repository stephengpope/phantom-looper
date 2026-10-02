// Looper — the card-run policy over the board: a card entering plan or
// in progress (with its switch on) gets a run — a coding session and a
// supervisor session under one lock identity — and the step rule drives
// their dialogue until the supervisor's verdict moves the card. User
// space: built on the backend SDK's sessions, cards and events and on the
// client SDK's agents over loopback. Stub: today's engine (engine.ts,
// logic.ts) moves in when the SDK's objects are real.
import type { PhantomBackend } from 'phantom-backend-sdk';

export class Looper {
  constructor(private readonly backend: PhantomBackend) {}
  /** Subscribe to the board and settings; start runs owed to cards already in their columns. */
  async start(): Promise<void> { throw stub(); }
  /** Interrupt every running turn and stop listening. */
  async stop(): Promise<void> { throw stub(); }
}
const stub = () => new Error('stub');
