// Steps — the ONE writer of a turn's steps. A STEP is one model answer and
// every tool result it asked for. Nothing of a step reaches the record
// before the step is whole: the driver hands the api the model's answer —
// the words that drove it, the assistant message, its usage, the calls it
// made — and the results of the tools it runs itself; the api runs the
// server tools; and once every call has its result, the api appends the
// step in ONE write: the drivers, the answer, the usage, the results in the
// order the calls were made.
//
// A step is never half-written. A driver that stops (esc) closes the step:
// what the model had said, the results in hand, and for every call still
// open the truth — interrupted before its result was read — then an
// `interrupted` line; one write. A driver that disconnects mid step hands
// the hold to a runner (Turns.handoff): the api keeps the step, closes the
// driver's own calls still open as interrupted (nobody will answer them),
// finishes its own tools, writes the step, and only then sends the runner
// the turn — its record whole. A driver that dies leaves the step open: the
// next holder closes it at its turn-start, before anything else is written.
// An api that restarts mid step forgets it: nothing of it was ever written,
// and the driver's turn fails with its words handed back.
//
// A CALL ID RUNS ONCE (claim): a caller that retried a slow tool POST is
// answered what the first run answered — the tool never runs twice. And
// the FIRST result filed for a call is the call's: a second (the driver
// reporting a server tool's answer it also saw) is ignored.
import type { ModelMessage, ToolModelMessage } from 'ai';
import type { SessionRow } from '../storage/schema.js';
import type { Sessions } from '../storage/Sessions.js';
import type { SessionEvents } from './SessionEvents.js';
import { messageLine, usageLine, interruptedLine, type TranscriptLine, type TokenUsage } from '@phantom-agent-sdk/client/transcript';
import { serverToolResultLine, interruptedResultMessage } from '@phantom-agent-sdk/client';
import { logger, errStr } from '../lib/log.js';

const log = logger('steps');

/** A call the model made: what the driver expects a result for. */
export interface StepCall { toolCallId: string; toolName: string }
/** The model's answer, as the driver hands it over. `usage` is absent for
 *  an answer cut before the call ended (a stop mid reply). */
export interface StepOpening { drivers: ModelMessage[]; assistant: ModelMessage | null; usage?: TokenUsage; calls: StepCall[] }
/** A result the driver drew itself (its own kit, a refusal, a failed request). */
export interface StepResult { toolCallId: string; toolName: string; message: ToolModelMessage }
/** What a write put in the record: the lines, and the record after them. */
export interface Written { lines: TranscriptLine[]; count: number; updated_at: string }
/** What a tool route answers: the status and the body it sends. */
export interface ToolAnswer { status: number; body: unknown }

interface OpenStep {
  holder: string;
  opening: StepOpening;
  results: Map<string, ToolModelMessage>;
  /** The calls the api runs itself (the tool route began them). */
  serverCalls: Set<string>;
  running: number;
  waiters: Array<() => void>;
  end: 'interrupted' | null;
}

/** How many answered call ids a session keeps (per process). A caller's
 *  repeat of a call comes right after the original; this is ample. */
const ANSWERS_KEPT = 32;

export class Steps {
  readonly #open = new Map<string, OpenStep>();
  readonly #writes = new Map<string, Promise<unknown>>();
  /** Per session, by call id: the answer this process made (or is making)
   *  for it — insertion-ordered, the oldest dropped past ANSWERS_KEPT. */
  readonly #answers = new Map<string, Map<string, Promise<ToolAnswer>>>();

  constructor(private readonly sessions: Sessions, private readonly events: SessionEvents) {}

  // ── the step ──────────────────────────────────────────────────────────

  /** The driver's step: held open until every call is answered, or written
   *  at once when the answer made no call. `results`: what the driver has
   *  already; `end`: the driver stopped — close it now with the truth. */
  open(sessionId: string, holder: string, opening: StepOpening, results: StepResult[] = [], end: 'interrupted' | null = null): Promise<Written | null> {
    const stale = this.#open.get(sessionId);
    if (stale) {
      log.warn({ session: sessionId, holder: stale.holder }, 'a step was still open — closed as interrupted before the next');
      void this.#finish(sessionId, stale, 'interrupted');
    }
    const step: OpenStep = { holder, opening, results: new Map(), serverCalls: new Set(), running: 0, waiters: [], end };
    this.#open.set(sessionId, step);
    for (const result of results) this.#file(step, result.toolCallId, result.message);
    return this.#settle(sessionId, step);
  }

  /** Results the driver drew itself. Refused when no step is open for it. */
  results(sessionId: string, holder: string, results: StepResult[]): Promise<Written | null> {
    const step = this.#open.get(sessionId);
    if (!step) { log.warn({ session: sessionId, holder }, 'results for no open step — dropped'); return Promise.resolve(null); }
    for (const result of results) this.#file(step, result.toolCallId, result.message);
    return this.#settle(sessionId, step);
  }

  /** The driver stopped, or died: the step closed with the truth — the
   *  results in hand, interrupted for the rest, an `interrupted` line. When
   *  the driver never handed the answer over (cut mid reply), `opening` is
   *  what it had. None open and nothing to open: nothing to write. */
  close(sessionId: string, holder: string, opening: StepOpening | null, results: StepResult[] = []): Promise<Written | null> {
    const step = this.#open.get(sessionId);
    if (!step) {
      if (!opening) return Promise.resolve(null);
      return this.open(sessionId, holder, opening, results, 'interrupted');
    }
    for (const result of results) this.#file(step, result.toolCallId, result.message);
    step.end = 'interrupted';
    return this.#settle(sessionId, step);
  }

  /** Is a step open on the session? */
  isOpen(sessionId: string): boolean { return this.#open.has(sessionId); }

  /** The driver handed the turn off mid step: its own calls still open are
   *  closed as interrupted — nobody will answer them — and the step is
   *  written once the api's own tools end. Resolves when the record is
   *  whole; at once when no step is open. */
  async handoff(sessionId: string): Promise<void> {
    const step = this.#open.get(sessionId);
    if (!step) return;
    for (const call of step.opening.calls) {
      if (!step.results.has(call.toolCallId) && !step.serverCalls.has(call.toolCallId)) this.#file(step, call.toolCallId, interruptedResultMessage(call));
    }
    if (step.running) log.info({ session: sessionId, running: step.running }, 'hand-off waits for the tool calls in flight');
    await this.#settle(sessionId, step);
    await this.#written(sessionId, step);
  }

  // ── the server's tools ────────────────────────────────────────────────

  /** A server tool call began on the session. Returns its `end`. */
  begin(sessionId: string, toolCallId: string): () => void {
    const step = this.#open.get(sessionId);
    if (step) { step.serverCalls.add(toolCallId); step.running++; }
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const now = this.#open.get(sessionId);
      if (now !== step || !step) return;
      step.running = Math.max(0, step.running - 1);
      if (!step.running) { for (const wake of step.waiters.splice(0)) wake(); }
    };
  }

  /** A server tool's result, run by the api: filed in the step, the step
   *  written when it was the last. A caller that no longer holds the session
   *  (it handed off mid call) relays nothing, so the result goes down the
   *  session feed from here, as the `tool-result` part it would have sent. */
  async serverResult(sessionId: string, caller: string, call: { toolCallId: string; toolName: string; input: unknown }, envelope: unknown): Promise<Written | null> {
    const step = this.#open.get(sessionId);
    if (!step) { log.warn({ session: sessionId, call: call.toolCallId }, 'server tool result for no open step — not recorded'); return null; }
    this.#file(step, call.toolCallId, serverToolResultLine(call, envelope).message as ToolModelMessage);
    const session = await this.sessions.get(sessionId).catch(() => undefined);
    if (session?.lockedBy && session.lockedBy !== caller) {
      this.events.publishPart(sessionId, session.lockedBy,
        { type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, input: call.input, output: envelope });
    }
    return this.#settle(sessionId, step);
  }

  /** A CALL ID IS RUN ONCE. The first request for an id runs `answer` and
   *  its outcome is the id's; a later request for the same id (a caller
   *  that retried a slow or timed-out call) gets that same answer, in
   *  flight or done — the tool is never run again. An `answer` that throws
   *  (the route's own failure, nothing filed) is forgotten, so the id can
   *  be tried afresh. */
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

  // ── the write ─────────────────────────────────────────────────────────

  /** The first result for a call is the call's. */
  #file(step: OpenStep, toolCallId: string, message: ToolModelMessage): void {
    if (step.results.has(toolCallId)) return;
    if (!step.opening.calls.some((call) => call.toolCallId === toolCallId)) {
      log.warn({ call: toolCallId }, 'a result for a call the answer did not make — dropped');
      return;
    }
    step.results.set(toolCallId, message);
  }

  #complete(step: OpenStep): boolean {
    return step.end !== null || step.opening.calls.every((call) => step.results.has(call.toolCallId));
  }

  /** Written when whole; null while calls are still open. */
  #settle(sessionId: string, step: OpenStep): Promise<Written | null> {
    if (!this.#complete(step)) return Promise.resolve(null);
    return this.#finish(sessionId, step, step.end);
  }

  /** Resolves once the step is written (whatever the outcome). */
  #written(sessionId: string, step: OpenStep): Promise<void> {
    if (this.#open.get(sessionId) !== step) return Promise.resolve();
    return new Promise((resolve) => { step.waiters.push(() => { void this.#written(sessionId, step).then(resolve); }); });
  }

  /** The one write: every line of the step, in order, under the session's
   *  hold. Writes for one session go one after another. */
  #finish(sessionId: string, step: OpenStep, end: 'interrupted' | null): Promise<Written | null> {
    if (this.#open.get(sessionId) === step) this.#open.delete(sessionId);
    const { opening } = step;
    const lines: TranscriptLine[] = [
      ...opening.drivers.map(messageLine),
      ...(opening.assistant ? [messageLine(opening.assistant)] : []),
      ...(opening.usage ? [usageLine(opening.usage)] : []),
    ];
    for (const call of opening.calls) {
      const result = step.results.get(call.toolCallId) ?? (end ? interruptedResultMessage(call) : null);
      if (result) lines.push(messageLine(result));
    }
    if (end === 'interrupted') lines.push(interruptedLine());
    const write = (this.#writes.get(sessionId) ?? Promise.resolve())
      .then(() => this.#append(sessionId, lines), () => this.#append(sessionId, lines))
      .finally(() => { for (const wake of step.waiters.splice(0)) wake(); });
    this.#writes.set(sessionId, write);
    return write;
  }

  async #append(sessionId: string, lines: TranscriptLine[]): Promise<Written | null> {
    if (!lines.length) return null;
    try {
      const session: SessionRow | undefined = await this.sessions.get(sessionId);
      if (!session?.lockedBy) { log.warn({ session: sessionId }, 'a step with no holder — not recorded'); return null; }
      const appended = await this.sessions.appendTranscript(session, session.lockedBy,
        { after: session.transcriptLines, deliveryId: `step-${lines[0].id}`, lines });
      return { lines, count: appended.lines, updated_at: appended.stamp.toISOString() };
    } catch (error) {
      log.warn({ session: sessionId, err: errStr(error) }, 'a step could not be recorded');
      return null;
    }
  }
}
