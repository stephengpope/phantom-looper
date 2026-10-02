// Notifications — channels a message can go out on (Telegram today; cli,
// Slack, Teams later) and the send. User space's digest and alerts call
// here; the notify tool does too. Stub.
export interface NotificationChannel { name: string; send(message: string): Promise<void> }

export class Notifications {
  addChannel(channel: NotificationChannel): void { throw stub(); }
  channels(): NotificationChannel[] { throw stub(); }
  /** Send on every channel that is up. */
  async send(message: string): Promise<void> { throw stub(); }
}
const stub = () => new Error('stub');
