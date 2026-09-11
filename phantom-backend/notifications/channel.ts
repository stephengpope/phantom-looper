// A notification channel — Telegram, CLI, Slack, Teams. Each platform
// implements `send()` and the digest timer delivers through whatever
// channels are registered.

export interface NotificationChannel {
  /** The platform name — for logging. */
  name: string;
  /** Send a plain-text notification. Best-effort: a failure is logged, never
   *  retried, and never blocks the caller. */
  send(message: string): Promise<void>;
}
