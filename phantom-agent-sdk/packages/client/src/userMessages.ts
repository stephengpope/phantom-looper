// The user message queue: what a PERSON sent while a turn ran, waiting to
// reach the model, in order. Text only, and only a person's words — the
// system's facts are the server's session notes, never queued here
// (docs/message-queues.md). What a drain triggers (riding or driving) is
// the Agent's rule, not the queue's; the Agent is the only one who adds and
// drains. Nothing is ever put back: words a failed run hands back go to the
// app (the Agent's `returned` event). An app sees the queue through
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

  take(id: number): QueueEntry | undefined {
    const i = this.entries.findIndex((entry) => entry.id === id);
    return i < 0 ? undefined : this.entries.splice(i, 1)[0];
  }
  clear(): QueueEntry[] { return this.entries.splice(0); }
}
