// The two queues of text waiting to reach the model.
//
// Nudges — the builder's own words (typed, spoken, Telegram). Ready text,
// or PENDING text (a voice note still transcribing) that holds the queue
// behind it until it settles.
//
// Injections — system facts (a background command exited, a file was
// dropped, files were pulled). Always ready.
//
// Both drain the same way: every ready entry from the front, stopping at the
// first pending one. What they TRIGGER differs, and that is the Agent's
// rule, not the queue's. A failed pending entry is dropped and reported
// through `onFailed` — never silently.
export interface QueueEntry<M = unknown> {
  readonly id: number;
  readonly meta?: M;
  text: string | null;
  settled: boolean;
  failed: boolean;
  error?: unknown;
}

let nextId = 1;

export class MessageQueue<M = unknown> {
  private entries: QueueEntry<M>[] = [];
  /** A pending entry settled (or failed) — the Agent may drain again. */
  onSettled?: (entry: QueueEntry<M>, error?: unknown) => void;

  get length(): number { return this.entries.length; }
  get ready(): number {
    let n = 0;
    for (const e of this.entries) { if (!e.settled) break; if (!e.failed) n++; }
    return n;
  }
  all(): readonly QueueEntry<M>[] { return this.entries; }

  add(text: string, meta?: M): QueueEntry<M> {
    const entry: QueueEntry<M> = { id: nextId++, meta, text, settled: true, failed: false };
    this.entries.push(entry);
    return entry;
  }

  /** Text that is still being produced. Resolves to the text, or null when
   *  nothing came of it (a transcription that heard nothing). */
  addPending(promise: Promise<string | null>, meta?: M): QueueEntry<M> {
    const entry: QueueEntry<M> = { id: nextId++, meta, text: null, settled: false, failed: false };
    this.entries.push(entry);
    promise.then(
      (text) => {
        entry.settled = true;
        if (text === null) { entry.failed = true; entry.error = new Error('nothing was transcribed'); }
        else entry.text = text;
        this.onSettled?.(entry, entry.error);
      },
      (err: unknown) => {
        entry.settled = true; entry.failed = true; entry.error = err;
        this.onSettled?.(entry, err);
      },
    );
    return entry;
  }

  /** Every ready entry from the front, up to the first pending one. Failed
   *  entries are removed and returned separately. */
  drain(): { texts: string[]; entries: QueueEntry<M>[]; failed: QueueEntry<M>[] } {
    const entries: QueueEntry<M>[] = [];
    const failed: QueueEntry<M>[] = [];
    while (this.entries.length) {
      const front = this.entries[0]!;
      if (!front.settled) break;
      this.entries.shift();
      if (front.failed) failed.push(front);
      else entries.push(front);
    }
    return { texts: entries.map((e) => e.text!), entries, failed };
  }

  /** Put drained entries back at the front — the model call they rode failed. */
  restore(entries: QueueEntry<M>[]): void {
    this.entries.unshift(...entries);
  }

  /** Text older than everything queued (the server's facts) — at the front, in order. */
  prepend(texts: string[]): void {
    const entries = texts.map((text): QueueEntry<M> => ({ id: nextId++, text, settled: true, failed: false }));
    this.entries.unshift(...entries);
  }

  /** Remove the last entry (the builder took it back). */
  pop(): QueueEntry<M> | undefined { return this.entries.pop(); }
  clear(): QueueEntry<M>[] { return this.entries.splice(0); }
}
