// The user message queue: the user's own words waiting to reach the model,
// in order. Text only. What a drain TRIGGERS is the Agent's rule, not the
// queue's.
//
// The server holds its own messages for a session's AI in
// ServerUserMessageQueue (phantom-server-sdk); that one writes to the transcript.
export interface QueueEntry {
  readonly id: number;
  readonly text: string;
}

let nextId = 1;

export class ClientUserMessageQueue {
  private entries: QueueEntry[] = [];

  get length(): number { return this.entries.length; }
  /** What is waiting, in order. */
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

  /** Remove the last entry (the user took it back). */
  pop(): QueueEntry | undefined { return this.entries.pop(); }
  clear(): QueueEntry[] { return this.entries.splice(0); }
}
