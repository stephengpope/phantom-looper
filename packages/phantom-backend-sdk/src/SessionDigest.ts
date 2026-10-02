// SessionDigest — every session_digest_interval_minutes, the sessions that
// went quiet since the last check (a turn ended, nobody looked) go out as
// one message on the notification channels. Off when the interval is 0. Stub.
export class SessionDigest {
  start(): void { throw stub(); }
  stop(): void { throw stub(); }
  /** One sweep now: find, send, mark digested. */
  async runOnce(): Promise<void> { throw stub(); }
}
const stub = () => new Error('stub');
