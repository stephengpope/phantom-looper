// The session feed, both directions, for one turn.
//
// OUT — the relay: every part of a turn this client runs is published to
// POST /sessions/:id/events so a watcher anywhere (another cli window, the
// Telegram bubble, the turn route's reply) sees it exactly as they see a
// turn the server runs. Batched (parts arrive many times a second), chained
// in order; the FIRST failure ends the relay for the turn with one notice —
// watchers repaint from the record when it lands. The turn never waits on
// it and never fails for it.
//
// IN — the stop signal: GET /sessions/:id/events carries {event:"interrupt"}
// when anyone stops the turn (esc in another window, /stop on Telegram, the
// interrupt route). Heard here, the turn is aborted exactly as a local
// interrupt would. The feed never echoes a client its own events.
import { call, headersFor, type PhantomBackend } from './backend.js';
import type { StreamPart } from './turn.js';

/** How long parts may sit before they are sent. The cli's own repaint rate. */
export const RELAY_FLUSH_MS = 150;

export class Relay {
  private buf: Record<string, unknown>[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private alive = true;

  constructor(private readonly backend: PhantomBackend, private readonly sessionId: string,
    private readonly onFailed: (reason: string) => void) {}

  turnStart(e: { agent: string; message: string; provider: string; model: string }): void {
    this.send([{ event: 'turn-start', ...e }]);
  }
  part(part: StreamPart): void {
    if (!this.alive) return;
    this.buf.push({ event: 'part', part });
    if (!this.timer) this.timer = setTimeout(() => this.flush(), RELAY_FLUSH_MS);
  }
  error(message: string): void { this.flush(); this.send([{ event: 'error', message }]); }
  /** turn-end, then the promise of the last send: the caller awaits it so
   *  the record's save is announced AFTER the turn closed on the feed. */
  turnEnd(): Promise<void> {
    this.flush();
    this.send([{ event: 'turn-end' }]);
    return this.chain;
  }

  private flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.buf.length) { const b = this.buf; this.buf = []; this.send(b); }
  }
  private send(events: Record<string, unknown>[]): void {
    if (!this.alive) return;
    this.chain = this.chain.then(async () => {
      if (!this.alive) return;
      try {
        await call(this.backend, 'POST', `/sessions/${this.sessionId}/events`, { events });
      } catch (e) {
        this.alive = false;
        this.onFailed((e as Error).message);
      }
    });
  }
}

/** Listen for the stop signal while a turn runs. Resolves the unsubscribe.
 *  Nothing is opened when the transport cannot stream. A feed that fails to
 *  open or drops is reported once; the turn goes on without it. */
export function watchForInterrupt(
  backend: PhantomBackend, sessionId: string, onInterrupt: () => void, onFailed: (reason: string) => void,
): () => void {
  if (backend.canStream === false) return () => undefined;
  const ac = new AbortController();
  const f = backend.fetch ?? fetch;
  const run = async () => {
    let r: Response;
    try {
      r = await f(`${backend.url}/sessions/${sessionId}/events`, { headers: headersFor(backend), signal: ac.signal });
    } catch (e) {
      if (!ac.signal.aborted) onFailed((e as Error).message);
      return;
    }
    if (!r.ok || !r.body) { onFailed(`session feed answered HTTP ${r.status}`); return; }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let rec: { event?: string };
          try { rec = JSON.parse(line) as { event?: string }; } catch { continue; }
          if (rec.event === 'interrupt') onInterrupt();
        }
      }
    } catch (e) {
      if (!ac.signal.aborted) onFailed((e as Error).message);
    }
  };
  run().catch((e: unknown) => onFailed(e instanceof Error ? e.message : 'session feed failed'));
  return () => ac.abort();
}
