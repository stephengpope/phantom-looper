// Watching what happens to a session elsewhere. The server publishes every
// part of a turn it runs (a looper round, POST /sessions/:id/turn) on
// `GET /sessions/:id/events`, plus lock, mode and transcript state; this
// object holds that feed open and folds what arrives into the SessionStore —
// through `remoteStart/remoteParts/remoteEnd`, which are the same reducer
// and the same block splitting a local turn goes through. Nothing here
// renders; nothing here holds conversation state. The store owns the
// conversation, this owns the wire.
//
// The window holds one of these per OPEN session (window.ts's watchSession):
// every session hears its own "someone else touched me" news live. Only the
// session on screen repaints — the store's fold paints the active id alone —
// so a background feed costs its connection and its parts, never a redraw.
import { FLUSH_MS } from './agent.js';
import { AUTO_PUSH_STEPS } from '../core/llm/tools/git.js';
import { followStream, type Stream } from './follow.js';
import type { SessionStore, LoadedSession } from './sessions.js';
import type { StreamPart } from './state.js';

export interface FeedHooks {
  /** The session's record was saved (by anyone). `keepScreen` is true when
   *  this window watched the whole turn that produced it: pull the transcript
   *  for history and the stamp, but leave the screen alone — it already shows
   *  that turn, drawn from the same stream the server recorded, with the
   *  thinking and the tool timings a transcript replay cannot carry.
   *  False = we missed something; repaint from the record. */
  onRecordLanded: (updatedAt: string, keepScreen: boolean) => Promise<void> | void;
  /** Plan mode changed on the server (another window's /plan, or a looper
   *  round flipping it). The App rebuilds the agent kit around this. */
  onPlanModeChanged?: (on: boolean) => Promise<void> | void;
}

const agentName = (agent: string): string | undefined =>
  agent === 'coding' ? 'coding agent' : agent === 'supervisor' ? 'supervisor' : undefined;

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
      onReconnect: () => {
        this.whole = false;
        this.ended = false;
        this.flush();
        this.store.remoteEnd(this.sessionId);
      },
    });
  }

  /** Stop watching (the session left the screen, or the window is closing).
   *  Whatever we drew is committed — a half-open block must not be left
   *  hanging under the pane — and the record still reaches this session the
   *  ordinary way: the snapshot and reseat on switching back. */
  stop(): void {
    this.flush();
    this.store.remoteEnd(this.sessionId);
    this.ac.abort();
  }

  private async apply(rec: Record<string, unknown>): Promise<void> {
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
      case 'sync': {
        // A git sync's step on this session, whoever kicked it off (a card
        // archive fires one detached). The window that ASKED for the sync
        // draws its own stream and the feed's echo rule keeps this copy from
        // it — a note here is always news from somewhere else.
        const step = String(rec.step ?? '');
        const op = rec.op === 'push' ? 'auto-push' : 'auto-pull';
        const detail = typeof rec.detail === 'string' && rec.detail ? ` — ${rec.detail}` : '';
        this.store.note(this.sessionId, `${op}: ${AUTO_PUSH_STEPS[step] ?? step}${detail}`);
        return;
      }
      case 'interrupt':
        // The stop signal (esc-esc in another window, /stop on telegram, the
        // interrupt route). If the turn is OURS, this ends it exactly as esc
        // here would; if no turn is ours, abortTurn is a no-op.
        this.store.abortTurn(this.sessionId);
        return;
      case 'transcript': {
        // Never our own upload: the server does not echo a client its own
        // events (the feed route's rule), so every record here is someone
        // else's work.
        const keep = this.whole && this.ended;
        this.whole = false;          // the next turn earns it again
        await this.hooks.onRecordLanded(String(rec.updated_at ?? ''), keep);
        return;
      }
      case 'lock': {
        // WHO comes from the session's seat, WHAT from the holder's own
        // label; a holder that is not one of our agents leaves just its
        // label (a hostname).
        if (!rec.locked) { this.store.setHeld(this.sessionId, null); return; }
        const agent = String(rec.agent ?? '');
        this.store.setHeld(this.sessionId, {
          who: agentName(agent),
          label: String(rec.label || 'another machine'),
          expiresAt: Date.parse(String(rec.expires_at ?? '')) || Number.MAX_SAFE_INTEGER,
        });
        return;
      }
      case 'session': {
        // Session state: agent seat, plan mode, work state. Published on
        // change AND on connect, so reconnects refill even if a save was missed.
        if (rec.agent !== undefined) {
          const a = String(rec.agent ?? '');
          const entry = this.store.get(this.sessionId);
          if (entry?.held) {
            this.store.setHeld(this.sessionId, {
              ...entry.held,
              who: agentName(a),
            });
          }
        }
        if (typeof rec.planMode === 'boolean') {
          await this.hooks.onPlanModeChanged?.(rec.planMode);
        }
        if (rec.work !== undefined) {
          this.store.setWork(this.sessionId, rec.work as LoadedSession['work']);
        }
        if (typeof rec.transcript_updated_at === 'string') {
          await this.hooks.onRecordLanded(rec.transcript_updated_at, false);
        }
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
