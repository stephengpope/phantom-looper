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

/** What a tool route answers: the status and the body it sends. */
export interface ToolAnswer { status: number; body: unknown }

/** How many answered call ids a session keeps (per process). A caller's
 *  repeat of a call comes right after the original; this is ample. */
const ANSWERS_KEPT = 32;

export class ToolCalls {
  readonly #inFlight = new Map<string, number>();
  readonly #waiters = new Map<string, Array<() => void>>();
  readonly #writes = new Map<string, Promise<unknown>>();
  /** Per session, by call id: the answer this process made (or is making)
   *  for it — insertion-ordered, the oldest dropped past ANSWERS_KEPT. */
  readonly #answers = new Map<string, Map<string, Promise<ToolAnswer>>>();

  constructor(private readonly sessions: Sessions, private readonly events: SessionEvents) {}

  /** A CALL ID IS RUN ONCE. The first request for an id runs `answer` and
   *  its outcome is the id's; a later request for the same id (a caller
   *  that retried a slow or timed-out call) gets that same answer, in
   *  flight or done — the tool is never run again and the record never
   *  takes a second result for the call. An `answer` that throws (the
   *  route's own failure, nothing recorded) is forgotten, so the id can be
   *  tried afresh. */
  claim(sessionId: string, toolCallId: string, answer: () => Promise<ToolAnswer>): Promise<ToolAnswer> {
    const answers = this.#answers.get(sessionId) ?? new Map<string, Promise<ToolAnswer>>();
    this.#answers.set(sessionId, answers);
    const prior = answers.get(toolCallId);
    if (prior) {
      log.warn({ session: sessionId, call: toolCallId }, 'tool call repeated — answered from the first run, not run again');
      return prior;
    }
    const made = answer().catch((error: unknown) => {
      if (answers.get(toolCallId) === made) answers.delete(toolCallId);
      throw error;
    });
    answers.set(toolCallId, made);
    while (answers.size > ANSWERS_KEPT) answers.delete(answers.keys().next().value!);
    return made;
  }

  /** The turn ended: its call ids are done with (a new turn never repeats one). */
  forget(sessionId: string): void { this.#answers.delete(sessionId); }

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
