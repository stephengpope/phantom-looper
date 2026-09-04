// Watching a session someone else is running. The server publishes every part
// of a turn it runs (a looper round, POST /sessions/:id/turn) on
// `GET /sessions/:id/events`; this object holds that feed open for the session
// ON SCREEN and folds what arrives into the SessionStore — through
// `remoteStart/remoteParts/remoteEnd`, which are the same reducer and the same
// block splitting a local turn goes through. Nothing here renders; nothing
// here holds conversation state. The store owns the conversation, this owns
// the wire.
//
// Only the session on screen is followed. A background session's live output
// is drawn by nobody, and holding a socket per open session to accumulate
// parts no one will read is cost without a reader.
import { FLUSH_MS } from './agent.js';
import { followStream, type Stream } from './follow.js';
import type { SessionStore } from './sessions.js';
import type { StreamPart } from './state.js';

export interface FeedHooks {
  /** The session's record was saved (by anyone). `keepScreen` is true when
   *  this window watched the whole turn that produced it: pull the transcript
   *  for history and the stamp, but leave the screen alone — it already shows
   *  that turn, drawn from the same stream the server recorded, with the
   *  thinking and the tool timings a transcript replay cannot carry.
   *  False = we missed something; repaint from the record. */
  onRecordLanded: (updatedAt: string, keepScreen: boolean) => void;
}

export class SessionFeed {
  private ac = new AbortController();
  /** Parts waiting for the next flush — deltas arrive many times a second and
   *  a repaint per token is the classic Ink flicker (agent.ts's rule, reused
   *  here so a watched turn and a driven turn paint at the same rate). */
  private buf: StreamPart[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Did this window see the CURRENT turn whole — its start, and its end?
   *  Only then can the screen be trusted in place of the record. Cleared by
   *  anything that puts a hole in what we were told. `ended` is the end: a
   *  record that lands with the turn still open (a relay that died mid-turn)
   *  is missing its tail here, so it repaints. */
  private whole = false;
  private ended = false;

  constructor(
    private stream: Stream,
    private sessionId: string,
    private store: SessionStore,
    private hooks: FeedHooks,
    private flushMs = FLUSH_MS,
  ) {}

  start(): void {
    void followStream(this.stream, `/sessions/${this.sessionId}/events`, this.ac.signal, {
      onRecord: (rec) => this.apply(rec),
      // A reconnect means records were missed: whatever is on screen may have
      // a hole in it, so the next record landing repaints from the transcript.
      onReconnect: () => { this.whole = false; },
    });
  }

  /** Stop watching (the session left the screen, or the window is closing).
   *  Whatever we drew is committed — a half-open block must not be left
   *  hanging under the pane — and the record still reaches this session the
   *  ordinary way: the watch poll, and the reseat on switching back. */
  stop(): void {
    this.flush();
    this.store.remoteEnd(this.sessionId);
    this.ac.abort();
  }

  private apply(rec: Record<string, unknown>): void {
    switch (rec.event) {
      case 'turn-start':
        this.flush();
        this.whole = true;
        this.ended = false;
        this.store.remoteStart(this.sessionId, String(rec.message ?? ''));
        return;
      case 'part': {
        const part = rec.part as StreamPart & { capped?: boolean };
        // A clipped tool result is less than the record holds: the screen must
        // be replaced by the truth at turn end rather than kept.
        if ((part as { capped?: boolean }).capped) this.whole = false;
        this.buf.push(part);
        const t = part.type;
        const isDelta = t === 'text-delta' || t === 'reasoning-delta' || t === 'tool-input-delta';
        if (isDelta) { if (!this.timer) this.timer = setTimeout(() => this.flush(), this.flushMs); }
        else this.flush();   // ordering: a non-delta flushes what is buffered ahead of it
        return;
      }
      case 'error':
        // The turn failed. The message is worth seeing, and a failed turn may
        // never be recorded at all — so the screen cannot stand in for it.
        this.whole = false;
        this.flush();
        this.store.note(this.sessionId, `the agent's turn failed — ${String(rec.message ?? 'unknown error')}`);
        return;
      case 'turn-end':
        this.flush();
        this.ended = true;
        this.store.remoteEnd(this.sessionId);
        return;
      case 'transcript': {
        // Never our own upload: the server does not echo a client its own
        // events (the feed route's rule), so every record here is someone
        // else's work.
        const keep = this.whole && this.ended;
        this.whole = false;          // the next turn earns it again
        this.hooks.onRecordLanded(String(rec.updated_at ?? ''), keep);
        return;
      }
      case 'lock': {
        // WHO comes from the session's seat, WHAT from the holder's own
        // label; a holder that is not one of our agents leaves just its
        // label (a hostname).
        if (!rec.locked) { this.store.setHeld(this.sessionId, null); return; }
        const agent = String(rec.agent ?? '');
        this.store.setHeld(this.sessionId, {
          ...(agent === 'coding' ? { who: 'coding agent' } : agent === 'supervisor' ? { who: 'supervisor' } : {}),
          label: String(rec.label || 'another machine'),
          expiresAt: Date.parse(String(rec.expires_at ?? '')) || Number.MAX_SAFE_INTEGER,
        });
        return;
      }
      default: return;               // heartbeat, and anything a newer server adds
    }
  }

  private flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.buf.length) return;
    const b = this.buf;
    this.buf = [];
    this.store.remoteParts(this.sessionId, b);
  }
}
