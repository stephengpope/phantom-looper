// Server settings change notices. The feed carries no values: a notice (or a
// reconnect, which may have missed one) makes the window re-read /settings.
import { followStream, type Stream } from './follow.js';

export class SettingsFeed {
  private ac = new AbortController();

  constructor(
    private stream: Stream,
    private onChanged: () => void,
    private clientId?: string,
  ) {}

  start(): void {
    void followStream(this.stream, '/settings/events', this.ac.signal, {
      onRecord: (rec) => {
        if (rec.event !== 'settings_changed') return;
        if (this.clientId && rec.client === this.clientId) return;
        this.onChanged();
      },
      onReconnect: this.onChanged,
    });
  }

  stop(): void { this.ac.abort(); }
}
