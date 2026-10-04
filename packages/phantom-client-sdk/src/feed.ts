// The session feed, both directions, for one turn.
//
// OUT — the relay: every part of a turn this client runs is published to
// POST /sessions/:id/events so a watcher anywhere (another client of the same
// session, the server's own readers) sees it exactly as they see a turn the
// server runs. Batched (parts arrive many times a second), chained in order;
// the FIRST failure ends the relay for the turn with one notice — watchers
// repaint from the record when it lands. The turn never waits on it and
// never fails for it.
//
// IN — the stop signal and the row: GET /sessions/:id/events carries
// {event:"interrupt"} when anyone stops the turn (another client, the
// interrupt route) — heard here, the turn is aborted exactly as a local
// interrupt would — and {event:"session", planMode?} when the row moves, so
// a plan-mode flip lands on the running turn's tools. The feed never echoes
// a client its own events.
import type { BackendClient } from './backend.js';
import type { StreamPart } from './turn.js';

/** How long parts may sit before they are sent. Parts arrive many times a
 *  second; a few per batch keeps the feed readable without visible lag. */
const RELAY_FLUSH_MS = 150;

class Relay {
  private buf: Record<string, unknown>[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private alive = true;

  constructor(private readonly backend: BackendClient, private readonly sessionId: string,
    private readonly onFailed: (reason: string) => void) {}

  turnStart(opening: { agent: string; message: string; provider: string; model: string }): void {
    this.send([{ event: 'turn-start', ...opening }]);
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
        await this.backend.call('POST', `/sessions/${this.sessionId}/events`, { events }, { retry: false });
      } catch (error) {
        this.alive = false;
        this.onFailed((error as Error).message);
      }
    });
  }
}

interface FeedListener {
  onInterrupt(): void;
  onPlanMode(on: boolean): void;
  /** The relay or the listener failed — once each; the turn goes on without it. */
  onNotice(text: string): void;
}

/** The feed for one turn: what this turn draws goes out (`part`, `error`,
 *  `end`), and while it runs the session's stop signal and row moves come
 *  in. `end` closes both and resolves once the last record went out. */
export class TurnFeed {
  readonly #relay: Relay;
  readonly #stop: () => void;

  constructor(backend: BackendClient, sessionId: string, opening: { agent: string; message: string; provider: string; model: string }, listener: FeedListener) {
    this.#relay = new Relay(backend, sessionId,
      (reason) => listener.onNotice(`live relay stopped for this turn (${reason}) — watchers see the record when it lands`));
    this.#stop = watchSession(backend, sessionId, listener,
      (reason) => listener.onNotice(`not listening to the session feed this turn (${reason})`));
    this.#relay.turnStart(opening);
  }

  part(part: StreamPart): void { this.#relay.part(part); }
  error(message: string): void { this.#relay.error(message); }
  end(): Promise<void> { this.#stop(); return this.#relay.turnEnd(); }
}

function watchSession(backend: BackendClient, sessionId: string, listener: FeedListener, onFailed: (reason: string) => void): () => void {
  const abort = new AbortController();
  const run = async () => {
    try {
      for await (const rec of backend.stream('GET', `/sessions/${sessionId}/events`, undefined, { signal: abort.signal })) {
        if (rec.event === 'interrupt') listener.onInterrupt();
        else if (rec.event === 'session' && typeof rec.planMode === 'boolean') listener.onPlanMode(rec.planMode);
      }
    } catch (error) {
      if (!abort.signal.aborted) onFailed((error as Error).message);
    }
  };
  run().catch((error: unknown) => onFailed(error instanceof Error ? error.message : 'session feed failed'));
  return () => abort.abort();
}
