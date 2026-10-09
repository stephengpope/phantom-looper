// Link — THE persistent connection to the backend, both directions, for
// everything that holds a line open: a cli window's feeds, a session host's
// job channel, an engine watching a session. One object, one policy:
//
//   DOWN  an ND-JSON feed (GET), followed forever: a link that goes silent
//         is dead (the server heartbeats every 15 s), so a stall watchdog
//         cuts it; reconnects back off 1 s → 10 s; a RECONNECT is a gap in
//         what we were told, so `onReconnect` runs before records resume.
//   UP    `send(record)`: batched, ordered, and NEVER dropped — a POST that
//         fails waits and tries again, forever, until `close()`.
//
// A drop is a status change and a later refill. It never ends the link,
// never fails a send, never stops anything on either side — only a record
// on the feed (an `interrupt`, a `kill` job) can do that. The transport
// underneath (BackendConnection: one HTTP/2 socket) is nobody's business
// above this file; changing it changes this file and nothing else.
import type { BackendClient } from './backend.js';

/** A server ND-JSON stream as records; ends when the signal aborts or the
 *  server hangs up; throws on a refusal. */
export type Stream = (path: string, signal: AbortSignal) => Promise<AsyncIterable<Record<string, unknown>>>;

/** No record for this long (the server heartbeats every 15 s) = a dead link:
 *  drop it and reconnect. */
export const STREAM_STALL_MS = 45_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 10_000;
/** How long sends may sit before they go. */
const FLUSH_MS = 150;

export interface FollowHooks {
  /** One record off the feed. */
  onRecord: (record: Record<string, unknown>) => Promise<void> | void;
  /** The link went silent (no record for STREAM_STALL_MS): the transport
   *  underneath is presumed dead and may be torn down here, so the
   *  reconnect opens a fresh one instead of queueing on the old. */
  onStall?: () => void;
  /** A link came back after one dropped — records were missed. Awaited before
   *  the new link's records are delivered, so the refill lands first. Never
   *  called for the FIRST connect (there is no gap to fill). */
  onReconnect?: () => Promise<void> | void;
  /** The link came up (true) or went down (false). Notice only. */
  onStatus?: (up: boolean) => void;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((wake) => {
  const timer = setTimeout(() => { signal.removeEventListener('abort', done); wake(); }, ms);
  const done = () => { clearTimeout(timer); wake(); };
  signal.addEventListener('abort', done, { once: true });
});

/** Hold `path` open until `signal` aborts. Never throws: a refusal or a drop
 *  is a reconnect, which is the whole point of the loop. ONE copy of the
 *  policy for every feed anything follows. */
export async function followStream(
  stream: Stream, path: string, signal: AbortSignal, hooks: FollowHooks,
): Promise<void> {
  let connected = false;
  let up = false;
  let backoff = BACKOFF_MIN_MS;
  const status = (next: boolean) => { if (up !== next) { up = next; hooks.onStatus?.(next); } };
  while (!signal.aborted) {
    // The stall watchdog: a per-link controller so a silent link can be cut
    // without ending the follow itself.
    const link = new AbortController();
    const onAbort = () => link.abort();
    signal.addEventListener('abort', onAbort);
    let stall: ReturnType<typeof setTimeout> | undefined;
    const armStall = () => { clearTimeout(stall); stall = setTimeout(() => { hooks.onStall?.(); link.abort(); }, STREAM_STALL_MS); };
    try {
      const records = await stream(path, link.signal);
      if (connected) await hooks.onReconnect?.();   // a reconnect — fill the gap
      connected = true;
      backoff = BACKOFF_MIN_MS;
      status(true);
      armStall();
      for await (const record of records) {
        if (signal.aborted) return;
        armStall();
        await hooks.onRecord(record);
      }
    } catch { /* dropped, refused, or refill failed — retry below */ }
    finally {
      // A failed refill must close the old socket before opening another.
      link.abort();
      clearTimeout(stall);
      signal.removeEventListener('abort', onAbort);
      status(false);
    }
    if (signal.aborted) return;
    await sleep(backoff, signal);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }
}

export interface LinkOptions extends FollowHooks {
  /** The feed followed: a GET route answering ND-JSON with heartbeats. */
  feed: string;
  /** Where `send` posts, as `{ events: [...] }`. Absent: a one-way link. */
  relay?: string;
  /** Tear the transport down (BackendConnection.destroy): called when the
   *  feed stalls and when a relay post fails, so what follows opens a fresh
   *  connection rather than waiting on a dead one. */
  reset?: () => void;
}

/** A relay post that gets no answer in this long is on a dead socket. */
const SEND_TIMEOUT_MS = 30_000;

export class Link {
  readonly #backend: BackendClient;
  readonly #opts: LinkOptions;
  readonly #abort = new AbortController();
  #up = false;
  #following: Promise<void> | null = null;
  // The relay: a queue, a flush timer, one send in flight at a time.
  #queue: Record<string, unknown>[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #sending = false;

  constructor(backend: BackendClient, opts: LinkOptions) {
    this.#backend = backend;
    this.#opts = opts;
  }

  /** Up right now — the feed is open. Notice only; nothing decides on it. */
  get up(): boolean { return this.#up; }
  get closed(): boolean { return this.#abort.signal.aborted; }

  /** Start following. Returns at once; the follow runs until `close`. */
  open(): void {
    if (this.#following) return;
    // Connected means the server answered: the first record (its opening
    // heartbeat) is awaited before the link counts as up — a generator alone
    // has not sent a request yet.
    const stream: Stream = async (path, signal) => {
      const records = this.#backend.stream('GET', path, undefined, { signal });
      const first = await records.next();
      return (async function* () {
        if (first.done) return;
        yield first.value;
        yield* records;
      })();
    };
    this.#following = followStream(stream, this.#opts.feed, this.#abort.signal, {
        onRecord: this.#opts.onRecord,
        onReconnect: this.#opts.onReconnect,
        onStall: () => { this.#opts.reset?.(); this.#opts.onStall?.(); },
        onStatus: (up) => { this.#up = up; this.#opts.onStatus?.(up); },
      });
  }

  /** Queue a record for the relay. Ordered after everything queued before
   *  it; sent in batches; retried until it lands or the link closes. */
  send(record: Record<string, unknown>): void {
    if (!this.#opts.relay) throw new Error('this link has no relay — nothing to send on');
    if (this.closed) return;
    this.#queue.push(record);
    if (!this.#timer && !this.#sending) this.#timer = setTimeout(() => void this.#flush(), FLUSH_MS);
  }

  /** The only way it ends. Queued sends are dropped here and nowhere else;
   *  a caller that must land its last words awaits `drain` first. */
  close(): void {
    this.#abort.abort();
    if (this.#timer) { clearTimeout(this.#timer); this.#timer = null; }
    this.#queue = [];
  }

  /** Resolves once everything queued so far has been delivered. */
  async drain(): Promise<void> {
    while ((this.#queue.length || this.#sending) && !this.closed) await sleep(50, this.#abort.signal);
  }

  async #flush(): Promise<void> {
    this.#timer = null;
    if (this.#sending || !this.#queue.length || this.closed) return;
    this.#sending = true;
    try {
      while (this.#queue.length && !this.closed) {
        const batch = this.#queue.splice(0, 200);
        let backoff = BACKOFF_MIN_MS;
        for (;;) {
          try {
            await this.#backend.call('POST', this.#opts.relay!, { events: batch },
              { retry: false, signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(SEND_TIMEOUT_MS)]) });
            break;
          } catch (error) {
            if (this.closed) return;
            this.#opts.reset?.();
            // A refusal the server will repeat (a 4xx) is a bug, not an
            // outage: dropping the batch is the only way forward. A transport
            // failure or a 5xx is the outage this loop exists for.
            const status = (error as { status?: number }).status;
            if (status !== undefined && status >= 400 && status < 500) break;
            await sleep(backoff, this.#abort.signal);
            backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
          }
        }
      }
    } finally {
      this.#sending = false;
      if (this.#queue.length && !this.closed && !this.#timer) this.#timer = setTimeout(() => void this.#flush(), FLUSH_MS);
    }
  }
}
