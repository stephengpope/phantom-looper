// The user message queue: the ONE way the server puts a message in front of
// a session's AI. Background tasks, instant sync, auto-push / auto-pull and
// cron all push here. Nothing here starts a turn.
//
// `add` queues. `drain` writes what is waiting into the transcript as user
// messages — the server calls it when a session lock is taken, under that
// lock, before the taker runs. So the messages land exactly when they are
// needed: right before the next turn reads the transcript. Nothing reads
// them sooner.
//
// A text already waiting for the session is not queued again (instant sync
// repeats its note until a turn takes it). In-memory: a message the server
// held across a restart is lost — the fact it reports lives in its own row.
import { messageLine, userMessage, type TranscriptLine } from 'phantom-client-sdk';

/** What the queue needs from the server: a way to append to a session's
 *  transcript. The backend implements it when it wires the queue in. */
export interface SessionAccess {
  appendTranscript(sessionId: string, lines: TranscriptLine[]): Promise<void>;
}

/** Per-session cap: a session that never gets a turn must not grow the map
 *  for ever. Oldest drop first — the newest fact is the one that matters. */
export const MAX_PER_SESSION = 50;

export class UserMessageQueue {
  #bySession = new Map<string, string[]>();

  constructor(private readonly access: SessionAccess) {}

  /** What is waiting for a session, in order. */
  pending(sessionId: string): readonly string[] {
    return this.#bySession.get(sessionId) ?? [];
  }

  /** Queue a message for the session's AI. Never starts a turn. */
  add(sessionId: string, text: string): void {
    const list = this.#bySession.get(sessionId) ?? [];
    if (list.includes(text)) return;
    list.push(text);
    if (list.length > MAX_PER_SESSION) list.splice(0, list.length - MAX_PER_SESSION);
    this.#bySession.set(sessionId, list);
  }

  /** Write everything waiting into the transcript. Called when a session
   *  lock is taken, under that lock. Answers what was written. A write that
   *  fails leaves the messages queued, in order. */
  async drain(sessionId: string): Promise<string[]> {
    const texts = this.#bySession.get(sessionId);
    if (!texts?.length) return [];
    this.#bySession.delete(sessionId);
    try {
      await this.access.appendTranscript(sessionId, texts.map((t) => messageLine(userMessage(t))));
    } catch (e) {
      this.#bySession.set(sessionId, [...texts, ...(this.#bySession.get(sessionId) ?? [])]);
      throw e;
    }
    return texts;
  }
}
