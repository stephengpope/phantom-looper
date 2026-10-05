// Notifications — the channels a message can go out on, and the send. The
// backend's digest and the agents' send_message tool call here; an app
// registers the channels it has (its Telegram bot today; Slack, Teams later)
// and says what each does with a message. A send that names a session is
// the agent speaking to the user outside its reply; the channel may tie it
// to that session (so a reply can find its way back).
export interface NotificationChannel {
  name: string;
  /** Deliver `text`. `sessionId` = the session speaking, when one is. */
  send(text: string, context?: { sessionId?: string }): Promise<void>;
}

export class NotificationsError extends Error {
  constructor(readonly code: 'no_channel' | 'send_failed', message: string) { super(message); this.name = 'NotificationsError'; }
}

export class Notifications {
  readonly #channels = new Map<string, NotificationChannel>();

  addChannel(channel: NotificationChannel): void { this.#channels.set(channel.name, channel); }
  removeChannel(name: string): void { this.#channels.delete(name); }
  channels(): NotificationChannel[] { return [...this.#channels.values()]; }
  /** Is there anywhere to send? */
  get available(): boolean { return this.#channels.size > 0; }

  /** Send on every channel. Throws `no_channel` when none is registered;
   *  `send_failed` with the first channel's reason when every channel failed. */
  async send(text: string, context: { sessionId?: string } = {}): Promise<void> {
    if (!this.#channels.size) throw new NotificationsError('no_channel', 'no notification channel is registered');
    const results = await Promise.allSettled(this.channels().map((channel) => channel.send(text, context)));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length === results.length) {
      throw new NotificationsError('send_failed', (failures[0]!.reason as Error)?.message ?? String(failures[0]!.reason));
    }
  }
}
