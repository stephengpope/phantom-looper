// The user message queue: what a PERSON sent while a turn ran, waiting to
// reach the model, in order. Text only, and only a person's words — the
// system's facts are the server's session notes, never queued here
// (docs/message-queues.md). What a drain triggers (riding or driving) is
// the Agent's rule, not the queue's; the Agent is the only one who adds and
// drains. Words a run took and the model never answered go back to the
// FRONT (they were said first) and wait — the next message takes them
// along; nothing retries on its own. An app sees the queue through
// `UserMessages`: what is waiting, and the two ways to take it back.
export interface QueueEntry {
  readonly id: number;
  readonly text: string;
}

/** The app's view of the queue. */
export interface UserMessages {
  readonly length: number;
  /** What is waiting, in order. */
  pending(): readonly QueueEntry[];
  /** Take one entry back (the user recalled it). */
  take(id: number): QueueEntry | undefined;
  /** Take everything back. */
  clear(): QueueEntry[];
}

let nextId = 1;

export class UserMessageQueue implements UserMessages {
  private entries: QueueEntry[] = [];

  get length(): number { return this.entries.length; }
  pending(): readonly QueueEntry[] { return this.entries; }

  add(text: string): QueueEntry {
    const entry: QueueEntry = { id: nextId++, text };
    this.entries.push(entry);
    return entry;
  }

  /** Everything waiting, taken, in order. */
  drain(): string[] {
    return this.entries.splice(0).map((entry) => entry.text);
  }

  /** Words a run took and the model never answered: back at the FRONT, in
   *  order, ahead of whatever arrived since. */
  unsent(texts: string[]): void {
    this.entries.unshift(...texts.map((text): QueueEntry => ({ id: nextId++, text })));
  }

  take(id: number): QueueEntry | undefined {
    const i = this.entries.findIndex((entry) => entry.id === id);
    return i < 0 ? undefined : this.entries.splice(i, 1)[0];
  }
  clear(): QueueEntry[] { return this.entries.splice(0); }
}
