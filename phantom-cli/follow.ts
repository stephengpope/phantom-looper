// Following a server ND-JSON feed, forever: connect, read records, and when
// the link dies come back. ONE copy of that policy, shared by everything that
// watches a stream — the board's `/workspaces/:id/events` and a session's
// `/sessions/:id/events`. Written twice it would drift the first time a
// timeout is tuned.
//
// The rules, all paid for by the board: a link that goes silent is dead (the
// server heartbeats every 15 s), so a stall watchdog cuts it rather than
// leaving a window watching nothing; reconnects back off 1 s → 10 s so an
// unreachable server is not hammered; and a RECONNECT is a gap in what we
// were told, so the caller gets a chance to refill before records resume.

/** A server ND-JSON stream as records; ends when the signal aborts or the
 *  server hangs up; throws on a refusal. */
export type Stream = (path: string, signal: AbortSignal) => Promise<AsyncIterable<Record<string, unknown>>>;

/** No record for this long (the server heartbeats every 15 s) = a dead link:
 *  drop it and reconnect. */
export const STREAM_STALL_MS = 45_000;

export interface FollowHooks {
  /** One record off the feed. */
  onRecord: (rec: Record<string, unknown>) => void;
  /** A link came back after one dropped — records were missed. Awaited before
   *  the new link's records are delivered, so the refill lands first. Never
   *  called for the FIRST connect (there is no gap to fill). */
  onReconnect?: () => Promise<void> | void;
}

/** Hold `path` open until `signal` aborts. Never throws: a refusal or a drop
 *  is a reconnect, which is the whole point of the loop. */
export async function followStream(
  stream: Stream, path: string, signal: AbortSignal, hooks: FollowHooks,
): Promise<void> {
  let connected = false;
  let backoff = 1000;
  while (!signal.aborted) {
    // The stall watchdog: a per-link controller so a silent link can be cut
    // without ending the follow itself.
    const link = new AbortController();
    const onAbort = () => link.abort();
    signal.addEventListener('abort', onAbort);
    let stall: ReturnType<typeof setTimeout> | undefined;
    const armStall = () => { clearTimeout(stall); stall = setTimeout(() => link.abort(), STREAM_STALL_MS); };
    try {
      const records = await stream(path, link.signal);
      if (connected) await hooks.onReconnect?.();   // a reconnect — fill the gap
      connected = true;
      backoff = 1000;
      armStall();
      for await (const rec of records) { armStall(); hooks.onRecord(rec); }
    } catch { /* dropped or refused — retry below */ }
    finally { clearTimeout(stall); signal.removeEventListener('abort', onAbort); }
    if (signal.aborted) return;
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 10_000);
  }
}
