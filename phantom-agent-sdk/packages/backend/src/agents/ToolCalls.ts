// ToolCalls — the server tool calls in flight per session, and the one
// writer of their results. WHOEVER RUNS A TOOL WRITES ITS RESULT: the api
// runs the server tools, so when one ends the api appends the result line to
// the session's record — under the hold, as its holder — and answers the
// caller with the line, which files it as its own (client toolkit.ts).
//
// Two things hang off the count: a hand-off waits for it to reach zero
// before the next driver is sent the turn (its record must hold every
// result first); and a caller's hang-up kills a command only while that
// caller still holds the session — a hold that moved means the turn went
// on without it, and the command runs to its end for the next driver.
//
// THE FEED CARRIES EVERY PART OF A TURN, whoever produced it. A caller that
// is still there relays its own tool results as it draws them; a caller that
// left (its hold moved) relays nothing, so the api sends that result down the
// session feed itself, as the same `tool-result` part — a window that was
// watching fills its row like any other.
//
// Writes for one session go one after another: two results landing at
// once would race the record's count.
import type { Sessions } from '../storage/Sessions.js';
import type { SessionEvents } from './SessionEvents.js';
import type { TranscriptLine } from '@phantom-agent-sdk/client/transcript';
import { serverToolResultLine } from '@phantom-agent-sdk/client';
import { logger, errStr } from '../lib/log.js';

const log = logger('tool-calls');

/** What the api hands back with a tool's answer: the line it wrote and the
 *  record as it stands after it. */
export interface WrittenLine { line: TranscriptLine; lines: number; updated_at: string }

export class ToolCalls {
  readonly #inFlight = new Map<string, number>();
  readonly #waiters = new Map<string, Array<() => void>>();
  readonly #writes = new Map<string, Promise<unknown>>();

  constructor(private readonly sessions: Sessions, private readonly events: SessionEvents) {}

  /** A server tool call began on the session. Returns its `end`. */
  begin(sessionId: string): () => void {
    this.#inFlight.set(sessionId, (this.#inFlight.get(sessionId) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.#inFlight.get(sessionId) ?? 1) - 1;
      if (left > 0) { this.#inFlight.set(sessionId, left); return; }
      this.#inFlight.delete(sessionId);
      for (const wake of this.#waiters.get(sessionId) ?? []) wake();
      this.#waiters.delete(sessionId);
    };
  }

  inFlight(sessionId: string): number { return this.#inFlight.get(sessionId) ?? 0; }

  /** Resolves once no server tool call is in flight on the session — their
   *  results written. At once when none is. */
  settled(sessionId: string): Promise<void> {
    if (!this.inFlight(sessionId)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.#waiters.get(sessionId) ?? [];
      waiters.push(resolve);
      this.#waiters.set(sessionId, waiters);
    });
  }

  /** A finished call's result: written to the session's record as its
   *  current holder, and — when `caller` no longer holds the session (it
   *  handed the turn off mid call) — sent down the session feed as the
   *  `tool-result` part the caller would have relayed. Null when nobody
   *  holds the session (the turn is over; the result has no turn to belong
   *  to) or the write failed — said in the log, never thrown over the
   *  tool's own answer. */
  record(sessionId: string, caller: string, call: { toolCallId: string; toolName: string; input: unknown }, envelope: unknown): Promise<WrittenLine | null> {
    const line = serverToolResultLine(call, envelope);
    const write = (this.#writes.get(sessionId) ?? Promise.resolve())
      .then(() => this.#write(sessionId, caller, call, envelope, line), () => this.#write(sessionId, caller, call, envelope, line));
    this.#writes.set(sessionId, write);
    return write;
  }

  async #write(sessionId: string, caller: string, call: { toolCallId: string; toolName: string; input: unknown }, envelope: unknown, line: TranscriptLine): Promise<WrittenLine | null> {
    try {
      const session = await this.sessions.get(sessionId);
      if (!session?.lockedBy) { log.warn({ session: sessionId }, 'tool result with no holder — not recorded'); return null; }
      const appended = await this.sessions.appendTranscript(session, session.lockedBy,
        { after: session.transcriptLines, deliveryId: `tool-${line.id}`, lines: [line] });
      if (session.lockedBy !== caller) {
        this.events.publishPart(sessionId, session.lockedBy,
          { type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, input: call.input, output: envelope });
      }
      return { line, lines: appended.lines, updated_at: appended.stamp.toISOString() };
    } catch (error) {
      log.warn({ session: sessionId, err: errStr(error) }, 'tool result could not be recorded');
      return null;
    }
  }
}
