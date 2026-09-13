// The session LIST's change notices (GET /sessions/events). The feed carries
// no rows: a notice — or a reconnect, which may have missed one — makes the
// window re-read GET /sessions, the one place the list's rule lives. Same
// shape as SettingsFeed, for the same reason.
//
// Coalesced: a running turn fires several notices a second (lock renewals,
// per-step saves), and each re-read is one request for every loaded row —
// so notices inside a short window collapse into one read.
import { followStream, type Stream } from './follow.js';

/** How long after the last notice the list re-reads. */
export const SESSIONS_FEED_COALESCE_MS = 250;

export class SessionsFeed {
  private ac = new AbortController();
  private clock: ReturnType<typeof setTimeout> | null = null;

  constructor(private stream: Stream, private onChanged: () => void) {}

  start(): void {
    void followStream(this.stream, '/sessions/events', this.ac.signal, {
      onRecord: (rec) => { if (rec.event === 'changed') this.schedule(); },
      onReconnect: this.onChanged,
    });
  }

  private schedule(): void {
    if (this.clock) clearTimeout(this.clock);
    this.clock = setTimeout(() => { this.clock = null; this.onChanged(); }, SESSIONS_FEED_COALESCE_MS);
  }

  stop(): void {
    this.ac.abort();
    if (this.clock) { clearTimeout(this.clock); this.clock = null; }
  }
}
