// The nudge queue: a shared object for injecting user messages into a running
// turn. Used by the CLI (sessions.ts) and the server (telegram engine, coding
// turn). The queue holds ready (text) and pending (promise-based, e.g. voice
// transcription) entries. `drain()` returns all ready entries from the front,
// stopping at the first pending — it never waits. `next()` takes one entry,
// awaiting if pending (the esc path). `pop()` removes the last entry (the
// /pop command). Callbacks let each platform wire its own UI:
//   onAdd    — Telegram: ⏳ reaction.  CLI: screen update.
//   onDrain  — Telegram: 👍 reaction.  CLI: show in history.
//   onRemove — Telegram: clear ⏳, send error. CLI: screen update.
//   onSettled — a pending entry resolved; the caller can drain again.

/** Metadata is generic — Telegram puts { messageId: number }, CLI puts nothing. */
export interface NudgeEntry<M = unknown> {
  readonly id: number;
  readonly meta?: M;
  /** The resolved text, or null while pending / on failure. */
  text: string | null;
  /** True once the promise settled (resolved or rejected). */
  settled: boolean;
  /** True if the promise rejected. */
  failed: boolean;
  /** The error if failed — never swallowed, surfaced through onRemove. */
  error?: unknown;
  /** The underlying promise for pending entries. Ready entries have none. */
  readonly promise?: Promise<string | null>;
}

export interface NudgeQueueCallbacks<M = unknown> {
  /** Fired when an entry is added (ready or pending). */
  onAdd?: (entry: NudgeEntry<M>) => void;
  /** Fired when entries are drained into an LLM call. */
  onDrain?: (entries: NudgeEntry<M>[]) => void;
  /** Fired when an entry is removed (pop, clear, or failed transcription).
   *  Includes the error when removal is due to a failure. */
  onRemove?: (entry: NudgeEntry<M>, reason: 'pop' | 'clear' | 'failed', error?: unknown) => void;
  /** Fired when a pending entry settles (resolved or rejected).
   *  The caller can drain again. Errors are included — never swallowed. */
  onSettled?: (entry: NudgeEntry<M>, error?: unknown) => void;
}

let nextEntryId = 1;

export class NudgeQueue<M = unknown> {
  private readonly entries: NudgeEntry<M>[] = [];
  private callbacks: NudgeQueueCallbacks<M>;

  constructor(callbacks: NudgeQueueCallbacks<M> = {}) {
    this.callbacks = callbacks;
  }

  /** Replace callbacks — used when a new turn starts and needs its own
   *  onDrain handler to mirror texts into its specific history and screen. */
  setCallbacks(callbacks: NudgeQueueCallbacks<M>): void {
    this.callbacks = callbacks;
  }

  /** Number of entries in the queue (ready + pending). */
  get length(): number { return this.entries.length; }

  /** Number of ready entries from the front (before the first pending). */
  get readyLength(): number {
    let n = 0;
    for (const e of this.entries) {
      if (e.text !== null && e.settled !== false) n++;
      else if (e.promise && !e.settled) break;
      // A failed entry that settled counts as "skippable" not "ready",
      // but drain handles it — readyLength is informational.
      else if (e.failed) n++;
      else break;
    }
    return n;
  }

  // ── Add ──────────────────────────────────────────────────────────────

  /** Add a ready (text) entry. */
  add(text: string, meta?: M): NudgeEntry<M> {
    const entry: NudgeEntry<M> = {
      id: nextEntryId++, text, settled: true, failed: false, meta,
    };
    this.entries.push(entry);
    this.callbacks.onAdd?.(entry);
    return entry;
  }

  /** Add a pending entry (e.g. voice transcription in progress).
   *  The promise should resolve to the transcribed text, or null on failure. */
  addPending(promise: Promise<string | null>, meta?: M): NudgeEntry<M> {
    const entry: NudgeEntry<M> = {
      id: nextEntryId++, text: null, settled: false, failed: false, meta, promise,
    };
    this.entries.push(entry);
    this.callbacks.onAdd?.(entry);

    // Track settlement synchronously via the settled flag.
    promise.then(
      (text) => {
        (entry as { text: string | null }).text = text;
        (entry as { settled: boolean }).settled = true;
        // A null resolve means "transcription returned nothing" — treat as failure.
        if (text === null) {
          (entry as { failed: boolean }).failed = true;
          (entry as { error?: unknown }).error = new Error('transcription returned no text');
          this.callbacks.onSettled?.(entry, entry.error);
        } else {
          this.callbacks.onSettled?.(entry);
        }
      },
      (err) => {
        (entry as { settled: boolean }).settled = true;
        (entry as { failed: boolean }).failed = true;
        (entry as { error?: unknown }).error = err;
        // Error is surfaced through onSettled — never swallowed.
        this.callbacks.onSettled?.(entry, err);
      },
    );

    return entry;
  }

  // ── Drain ────────────────────────────────────────────────────────────

  /** Take all ready entries from the front, stopping at the first pending.
   *  Failed entries are removed (onRemove fires with the error) and skipped.
   *  Returns the texts — what gets injected into the LLM call. */
  drain(): string[] {
    const drained: NudgeEntry<M>[] = [];
    while (this.entries.length > 0) {
      const front = this.entries[0];
      if (front.settled) {
        this.entries.shift();
        if (front.failed) {
          // Failed transcription — remove, surface error, skip.
          this.callbacks.onRemove?.(front, 'failed', front.error);
          continue;
        }
        // Ready — include it.
        drained.push(front);
      } else {
        // Pending and not settled — stop.
        break;
      }
    }
    if (drained.length > 0) {
      this.callbacks.onDrain?.(drained);
    }
    return drained.map(e => e.text!);
  }

  // ── Next (esc) ───────────────────────────────────────────────────────

  /** Take one entry from the front. Awaits if pending (the esc path).
   *  Returns the text, or null if it failed. */
  async next(): Promise<{ text: string; entry: NudgeEntry<M> } | null> {
    if (this.entries.length === 0) return null;
    const front = this.entries[0];
    if (front.settled) {
      this.entries.shift();
      if (front.failed) {
        this.callbacks.onRemove?.(front, 'failed', front.error);
        return null;
      }
      this.callbacks.onDrain?.([front]);
      return { text: front.text!, entry: front };
    }
    // Pending — await it.
    try {
      const text = await front.promise!;
      this.entries.shift();
      if (text === null) {
        this.callbacks.onRemove?.(front, 'failed', front.error);
        return null;
      }
      this.callbacks.onDrain?.([front]);
      return { text, entry: front };
    } catch (err) {
      this.entries.shift();
      this.callbacks.onRemove?.(front, 'failed', err);
      return null;
    }
  }

  // ── Pop / Clear ──────────────────────────────────────────────────────

  /** Remove the last entry (/pop). Returns it, or undefined if empty. */
  pop(): NudgeEntry<M> | undefined {
    const entry = this.entries.pop();
    if (entry) {
      this.callbacks.onRemove?.(entry, 'pop');
    }
    return entry;
  }

  /** Remove all entries (/pop all). Returns them. */
  clear(): NudgeEntry<M>[] {
    const removed = this.entries.splice(0);
    for (const entry of removed) {
      this.callbacks.onRemove?.(entry, 'clear');
    }
    return removed;
  }

  // ── Inspection ───────────────────────────────────────────────────────

  /** All entries, for display (e.g. "2 queued"). Do not mutate. */
  all(): readonly NudgeEntry<M>[] { return this.entries; }
}
