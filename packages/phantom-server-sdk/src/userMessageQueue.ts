// The user message queue: the ONE way the server puts a message in front of
// a session's AI. Background tasks, instant sync, auto-push / auto-pull and
// cron all push here. Nothing here starts a turn.
//
// A queued message is written into the transcript as a user message, under
// the session lock:
//   lock free  → `add` takes the lock, writes, releases.
//   lock held  → the message waits. The holder ends its turn through
//                `release`: write what is waiting, release the lock, then
//                write again if anything arrived in between. Whoever takes
//                the lock next reads a transcript that already has it.
//
// A text already waiting for the session is not queued again (instant sync
// repeats its note until a turn takes it). In-memory: a message the server
// held across a restart is lost — the fact it reports lives in its own row.
import { messageLine, userMessage, type TranscriptLine } from 'phantom-client-sdk';

/** What the queue needs from the server. The backend implements this over
 *  its own session store when it wires the queue in. */
export interface SessionAccess {
  /** Take the session lock. false when someone else holds it. */
  tryLock(sessionId: string): Promise<boolean>;
  releaseLock(sessionId: string): Promise<void>;
  /** Append lines to the session's transcript. */
  appendTranscript(sessionId: string, lines: TranscriptLine[]): Promise<void>;
}

/** Per-session cap: a session that never gets a turn must not grow the map
 *  for ever. Oldest drop first — the newest fact is the one that matters. */
export const MAX_PER_SESSION = 50;

export class UserMessageQueue {
  #bySession = new Map<string, string[]>();
  /** Flushes in progress, one per session: a second flush waits for the first. */
  #flushing = new Map<string, Promise<string[]>>();

  constructor(private readonly access: SessionAccess) {}

  /** What is waiting for a session, in order. */
  pending(sessionId: string): readonly string[] {
    return this.#bySession.get(sessionId) ?? [];
  }

  /** Queue a message for the session's AI. Written now if the lock is free;
   *  otherwise when the holder ends its turn. Never starts a turn. */
  async add(sessionId: string, text: string): Promise<void> {
    const list = this.#bySession.get(sessionId) ?? [];
    if (list.includes(text)) return;
    list.push(text);
    if (list.length > MAX_PER_SESSION) list.splice(0, list.length - MAX_PER_SESSION);
    this.#bySession.set(sessionId, list);
    await this.writeIfFree(sessionId);
  }

  /** How a lock holder ends its turn. Everything waiting is written, the
   *  lock is released, and anything that arrived during the release is
   *  written under a fresh lock — so no message is left waiting for a turn
   *  that may never come. A write that fails leaves the messages queued and
   *  still releases. */
  async release(sessionId: string): Promise<void> {
    try { await this.flush(sessionId); }
    finally { await this.access.releaseLock(sessionId); }
    await this.writeIfFree(sessionId);
  }

  /** Write everything waiting into the transcript, under a lock the caller
   *  holds. Answers what was written. A write that fails leaves the
   *  messages queued. */
  flush(sessionId: string): Promise<string[]> {
    const running = this.#flushing.get(sessionId);
    if (running) return running.then(() => this.flush(sessionId));
    const p = this.#write(sessionId).finally(() => {
      if (this.#flushing.get(sessionId) === p) this.#flushing.delete(sessionId);
    });
    this.#flushing.set(sessionId, p);
    return p;
  }

  /** Nothing holds the lock → take it, write, release. Held → the holder's
   *  release will write. */
  async writeIfFree(sessionId: string): Promise<void> {
    if (!this.pending(sessionId).length) return;
    if (!(await this.access.tryLock(sessionId))) return;
    await this.release(sessionId);
  }

  async #write(sessionId: string): Promise<string[]> {
    const texts = this.#bySession.get(sessionId);
    if (!texts?.length) return [];
    this.#bySession.delete(sessionId);
    try {
      await this.access.appendTranscript(sessionId, texts.map((t) => messageLine(userMessage(t))));
    } catch (e) {
      // Back at the front, ahead of anything queued meanwhile: a failed
      // write must not eat them.
      this.#bySession.set(sessionId, [...texts, ...(this.#bySession.get(sessionId) ?? [])]);
      throw e;
    }
    return texts;
  }
}
