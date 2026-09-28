// The user message queue: the user's own words waiting to reach the model,
// in order. Text only. What a drain TRIGGERS is the Agent's rule, not the
// queue's; the Agent is the only one who adds and drains. An app sees the
// queue through `UserMessages`: what is waiting, and the two ways to take
// something back before it is sent.
//
// The server holds its own notes for a session's next turn; the Agent takes
// those as a turn starts (POST /sessions/:id/backdoor/drain).
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
    return this.entries.splice(0).map((e) => e.text);
  }

  take(id: number): QueueEntry | undefined {
    const i = this.entries.findIndex((e) => e.id === id);
    return i < 0 ? undefined : this.entries.splice(i, 1)[0];
  }
  clear(): QueueEntry[] { return this.entries.splice(0); }
}
