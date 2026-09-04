// One session's live traffic: the parts of a turn the SERVER runs, as they
// happen, plus the moment its record lands. Same shape and same reasoning as
// boardEvents.ts — one api process, so an in-process emitter is the whole bus
// — but keyed by SESSION, so a watcher of one conversation is never handed
// another's tokens.
//
// Publishers: runCodingTurn (every part of a coding turn), the looper's
// supervisor turn, POST /sessions/:id/events (a cli window relaying the turn
// IT runs — the same records, over HTTP), and PUT /sessions/:id/transcript
// (the one place that knows the record landed). Subscribers: GET
// /sessions/:id/events, and the POST /sessions/:id/turn route, which maps the
// same parts into its own ND-JSON reply.
//
// Every event carries WHO published it (`by`, the client id holding the
// session), and the feed never hands a client its own events back: a window
// relaying its turn would otherwise hear itself and draw the reply twice.
// That is the one rule about echoes, and it lives on the server, in the feed
// route — not in every client.
//
// The parts ride VERBATIM as the AI SDK emits them: the cli folds them with
// `applyPart`, the same reducer its own local turns use, so a watched turn and
// a driven turn are drawn by one renderer. Considered and rejected: the
// reduced {type:'text'|'tool'} shape this file replaced — it needs a second
// renderer on the client and structurally cannot carry reasoning, tool inputs,
// tool results or errors.
import { EventEmitter } from 'node:events';

export type SessionEvent =
  /** A server-side turn began: the text it is answering, so a watcher sees
   *  the question and not just a reply out of nowhere. */
  | { event: 'turn-start'; agent: 'coding' | 'supervisor'; message: string }
  /** One AI SDK stream part, verbatim (tool results capped — see CAP_BYTES). */
  | { event: 'part'; part: Record<string, unknown> }
  | { event: 'turn-end' }
  | { event: 'error'; message: string }
  /** The transcript was saved: the record moved. `by` is the client that
   *  wrote it. */
  | { event: 'transcript'; updated_at: string; by: string }
  /** The session's hold changed — taken, renewed, released — or, as the
   *  FIRST record of every feed, what it is right now. This is what a
   *  watcher's spinner reads: `label` is the holder's own word for the
   *  work (the loop's planning/building/reviewing, a window's hostname),
   *  `agent` the session's seat, `expires_at` when the hold lapses on its
   *  own if the holder dies — a watcher clears the spinner then without
   *  being told. */
  | { event: 'lock'; locked: boolean; by: string | null; label: string | null;
    agent: string | null; expires_at: string | null };

/** How much of a tool result rides the live feed. The screen shows a 5-row
 *  tail of an output and the whole thing arrives with the turn-end transcript
 *  pull, so bytes past this are read by nobody — while an uncapped `read` of a
 *  big file would push megabytes at every watcher. A capped part is MARKED,
 *  and the cli repaints from the record at turn end when it sees one: a
 *  clipped row must never be mistaken for the truth. */
export const CAP_BYTES = 16 * 1024;

/** Cap a part before it goes out. Only tool results carry unbounded payloads;
 *  everything else is a token or a name. */
export function capPart(part: Record<string, unknown>): Record<string, unknown> {
  if (part.type !== 'tool-result') return part;
  const json = JSON.stringify(part.output ?? null);
  if (json.length <= CAP_BYTES) return part;
  return { ...part, output: `${json.slice(0, CAP_BYTES)}…`, capped: true };
}

/** The wildcard channel's name — a session id is a ULID, never this. */
const ALL = '*';

export class SessionEvents {
  private emitter = new EventEmitter();
  constructor() { this.emitter.setMaxListeners(0); }
  /** `by` is the publisher's client id — the session's lock holder. */
  publish(sessionId: string, by: string, e: SessionEvent): void {
    this.emitter.emit(sessionId, e, by);
    this.emitter.emit(ALL, sessionId, e, by);
  }
  /** Publish one stream part, capped. Kept here so every publisher caps the
   *  same way — one rule, one place. */
  publishPart(sessionId: string, by: string, part: unknown): void {
    this.publish(sessionId, by, { event: 'part', part: capPart(part as Record<string, unknown>) });
  }
  subscribe(sessionId: string, fn: (e: SessionEvent, by: string) => void): () => void {
    this.emitter.on(sessionId, fn);
    return () => { this.emitter.off(sessionId, fn); };
  }
  /** Every session's events — for the server's own reactions to a turn
   *  (the turn-start hook in the session routes), never for a client. */
  subscribeAll(fn: (sessionId: string, e: SessionEvent, by: string) => void): () => void {
    this.emitter.on(ALL, fn);
    return () => { this.emitter.off(ALL, fn); };
  }
}
