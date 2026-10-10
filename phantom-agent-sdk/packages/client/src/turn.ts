// One turn: the model is called, tools run, the model is called again, until
// it stops calling tools (or maxSteps). Then, if the user sent more while it
// ran, the same turn goes on with that text. A stop cuts the model loop it
// lands in; whether the turn goes on is the caller's (`afterStop`: the words
// to go on with, or none). One turn, one lock, one result, however many
// loops. ONE runner for every agent and every host. What differs by host is
// only where the parts go (`onPart`).
//
// What is recorded, and when (the record is the server's transcript). Every
// write goes out in order on the record's one queue, and the turn does NOT
// wait for it — the stream and the tools run on. The turn waits for its
// writes once, before it returns. A write that fails after retries STOPS
// the turn (transcript_write_failed). Nothing runs unrecorded.
//
// The user's words reach a model run one of two ways:
//   driving → the words a run OPENS with: the turn's message, or what was
//             queued when the model had stopped. Written with the model's
//             first answer. If the run fails before that answer they were
//             never written, and they are handed back (`unsent`).
//   riding  → words queued while the model is mid-run, joining its next
//             call. Written the moment they are taken; never handed back.
//
//   model call answered → the drivers, the assistant message, the usage line.
//   each tool finished  → its result, as it lands — unless the SERVER ran it:
//                         whoever runs a tool writes its result, so the api
//                         wrote that line and the kit filed it (recordedByServer).
//                         A tool runs only once the message that asked for it
//                         is in the record, so results always follow their call.
//   interrupted         → the drivers if still unanswered, partial text and
//                         every tool call seen, results for finished tools,
//                         INTERRUPTED_RESULT for the rest, an `interrupted` line.
//   handed off          → nothing. At a STEP BOUNDARY (the model answered,
//                         every tool result in) `handoff()` is a stop condition
//                         and the record is whole. MID TOOL CALLS (the model
//                         answered, server tools still running) a disconnect
//                         hands off at once (`handoffNow`): the loop is cut, the
//                         api finishes the tools and writes their results, and
//                         the next driver starts once they are in.
import { streamText, stepCountIs, hasToolCall, type AssistantContent, type LanguageModel, type ModelMessage, type SystemModelMessage,
  type TextStreamPart, type Tool, type ToolCallPart } from 'ai';
import { PhantomError, asPhantomError } from './errors.js';
import { isContextTooLong } from './model/languageModel.js';
import { withRollingCacheMark } from './model/cache.js';
import type { ModelSpec, Reasoning } from './model/llmConfig.js';
import { assistantMessageFrom, toolResultMessage, interruptedResultMessage } from './messages.js';
import { messageLine, usageLine, interruptedLine, userMessage, type TokenTotals, type TranscriptLine } from './transcript.js';

/** One part of the model stream, as the AI SDK emits it. Apps see every
 *  part (`onPart`); the turn reads the six it records from. */
export type StreamPart = TextStreamPart<Record<string, Tool>>;
type ToolCall = { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown };
type ToolResult = { type: 'tool-result' | 'tool-error'; toolCallId: string; toolName: string; input: unknown; output?: unknown; error?: unknown };
type KnownPart = { type: 'text-delta'; text: string } | ToolCall | ToolResult
  | { type: 'finish-step' } | { type: 'error'; error: unknown } | { type: string };

export interface TurnResult {
  /** The final reply text (the last step's). */
  text: string;
  /** Every message this turn added to the conversation, in order. */
  messages: ModelMessage[];
  usage: TokenTotals;
  /** `handed_off`: the turn stopped at a step boundary for another driver
   *  to go on with (TurnInput.handoff); the record is whole, no mark written. */
  outcome: 'done' | 'interrupted' | 'handed_off';
}

export interface TurnInput {
  model: LanguageModel;
  /** What `model` is — named on every usage line. */
  spec: ModelSpec;
  system: SystemModelMessage[];
  tools: Record<string, Tool>;
  /** Tools whose call ends the turn after its result lands. */
  terminal: readonly string[];
  /** The conversation so far, as it stands when the turn starts. The
   *  caller's copy may grow as `record` lands lines; the turn reads it once. */
  history: readonly ModelMessage[];
  maxSteps: number | null;
  reasoning: Reasoning | undefined;
  /** A fresh signal for each model loop: a stop aborts the loop it was
   *  given to, and only that loop. */
  loopSignal(): AbortSignal;
  /** After a stopped loop: the words the turn goes on with (they drive the
   *  next run), or none to end it as interrupted. */
  afterStop(): string[];
  /** What the turn opens with. */
  opening: string[];
  /** The user messages that arrived since, taken: before every model call
   *  (they ride it, or drive it when it opens a run) and once more when the
   *  model stops (they drive the next run). */
  pending(): string[];
  /** Append to the record. Called in order; each call must enqueue its
   *  write before it returns, so the writes land in the order made.
   *  Rejects → the turn fails. */
  record(lines: TranscriptLine[]): Promise<void>;
  onPart(part: StreamPart): void;
  /** A tool answered with an error (the model still gets it). */
  onToolError(name: string, error: unknown): void;
  /** A run failed before its drivers were written: those words are the
   *  caller's again. Riders are never handed back — they were written. */
  unsent(texts: string[]): void;
  /** Asked after every step whose tool calls all landed: true ends the turn
   *  there as `handed_off` — the model is not called again here. A step that
   *  ended the run on its own (the model stopped, a terminal tool) is done,
   *  whatever this says. */
  handoff(): boolean;
  /** Tools whose results the server writes to the record (it ran them): the
   *  turn writes nothing for these, and never a placeholder either. */
  recordedByServer: ReadonlySet<string>;
  /** Hear a disconnect the moment it is asked (the turn may hand off at once
   *  while server tools run). Answers the unsubscribe. */
  onDisconnect(listener: () => void): () => void;
  /** Hand the turn off NOW, mid tool calls: true when a runner took it — the
   *  loop is cut and the turn ends `handed_off`, writing nothing (the api
   *  finishes the tools and writes their results); false to go on here. */
  handoffNow(): Promise<boolean>;
}

/** The step in flight, from its parts: text, tool calls, results. Used for
 *  the cut step — an interrupt closes the stream before the model call
 *  ends — and to know which calls still owe a result. */
class StepInFlight {
  text = '';
  calls: ToolCallPart[] = [];
  answered = new Set<string>();
  /** Results that arrived before the assistant message was recorded. */
  held: TranscriptLine[] = [];
  assistantRecorded = false;
  /** The write of this step's assistant message: a tool runs after it landed. */
  written: Promise<unknown> = Promise.resolve();
  reset(): void { this.text = ''; this.calls = []; this.answered = new Set(); this.held = []; this.assistantRecorded = false; this.written = Promise.resolve(); }
}

/** What one turn accumulates across its model loops. */
interface Tally { added: ModelMessage[]; usage: TokenTotals; text: string }

/** The circuit breaker: the same tool, the same input, failing this many
 *  times in a row ends the turn (tool_loop). A model stuck retrying a call
 *  that cannot work would otherwise run until a person stepped in; a turn
 *  that does real work never trips it — every other call resets the count. */
export const TOOL_FAILURE_LIMIT = 5;

/** Counts a tool's identical failures in a row. */
class RepeatedFailures {
  #signature = '';
  #count = 0;
  /** A call failed: how many times in a row this exact call has now. */
  failed(toolName: string, input: unknown): number {
    const signature = `${toolName}:${JSON.stringify(input) ?? ''}`;
    this.#count = signature === this.#signature ? this.#count + 1 : 1;
    this.#signature = signature;
    return this.#count;
  }
  /** A call succeeded: the run is over. */
  succeeded(): void { this.#signature = ''; this.#count = 0; }
}

/** The record failure, if one landed during the callbacks. Read through a
 *  function: the field is set from AI SDK callbacks, which TypeScript cannot
 *  see, so an inline read is narrowed to its initial null. */
function throwIfFailed(state: { recordFailure: PhantomError | null }): void {
  if (state.recordFailure) throw state.recordFailure;
}

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const tally: Tally = { added: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, text: '' };
  // The conversation as the turn found it. `record` grows the caller's copy
  // as lines land, so the loops below build from this snapshot plus what
  // the turn added — never from a copy that already holds the additions.
  const history = [...input.history];
  let carry = input.opening;
  for (;;) {
    const ended = await runModelLoop(input, history, carry, tally);
    if (ended === 'handed_off') return { text: tally.text, messages: tally.added, usage: tally.usage, outcome: 'handed_off' };
    const stopped = ended === 'stopped';
    // Stopped: the caller says whether the turn goes on. Done: anything the
    // user sent meanwhile that did not ride a call continues this turn — the
    // reply the user is waiting for is to everything they said.
    carry = stopped ? input.afterStop() : input.pending();
    if (!carry.length) return { text: tally.text, messages: tally.added, usage: tally.usage, outcome: stopped ? 'interrupted' : 'done' };
  }
}

/** How one model loop ended: the model stopped on its own (or a terminal
 *  tool ended it), a stop cut it, or the hand-off condition held at a step
 *  boundary. */
type LoopEnd = 'done' | 'stopped' | 'handed_off';

/** One model ↔ tools loop over `history + tally.added`, opening with
 *  `carry` (its drivers). */
async function runModelLoop(input: TurnInput, history: readonly ModelMessage[], carry: string[], tally: Tally): Promise<LoopEnd> {
  const outer = input.loopSignal();
  const abort = new AbortController();
  const onOuterAbort = () => abort.abort(outer.reason);
  if (outer.aborted) onOuterAbort();
  else outer.addEventListener('abort', onOuterAbort, { once: true });

  const step = new StepInFlight();
  // Set from the AI SDK's callbacks, read after the stream — a holder, so
  // the reads are not narrowed to their initial values.
  //   drivers   — this run's opening words, not yet sent with a written answer
  //   unwritten — drivers whose answer's write is still on its way
  //   writes    — the record queue's tail: awaited once, before returning
  const state: { drivers: ModelMessage[]; unwritten: ModelMessage[]; writes: Promise<void>; recordFailure: PhantomError | null } =
    { drivers: carry.map(userMessage), unwritten: [], writes: Promise.resolve(), recordFailure: null };
  try {
    return await streamModelLoop();
  } catch (error) {
    // The run failed with its drivers never written: they are the caller's
    // again. (A stop writes them before it returns — see below.)
    const back = [...state.unwritten, ...state.drivers];
    if (back.length) input.unsent(back.map(userText));
    throw error;
  }

  async function streamModelLoop(): Promise<LoopEnd> {
    let streamFailure: unknown;
    /** The hand-off condition, read where the AI SDK reads it: after a step
     *  whose tool calls all landed. Remembered so the end can tell a stop
     *  the condition made from one the model made. */
    let handedOff = false;
    /** The turn left mid tool calls (handoffNow took): the loop was cut for
     *  it, and nothing is written — the api owes the open results. */
    let handedOffMidTools = false;
    let handingOff = false;
    /** Server tool calls running right now — what a disconnect can leave to the api. */
    let serverToolsInFlight = 0;
    const offDisconnect = input.onDisconnect(() => {
      if (!step.assistantRecorded || serverToolsInFlight === 0 || handingOff) return;
      handingOff = true;
      void input.handoffNow().then((taken) => {
        if (taken) { handedOffMidTools = true; abort.abort(new Error('handed off')); }
        else handingOff = false;
      });
    });
    /** Set by the breaker: the stream is cut like a stop, the cut step
     *  recorded, then this is thrown instead of the stop's return. */
    let tripped: PhantomError | undefined;
    const failures = new RepeatedFailures();

    // Every record goes through here, in order, without waiting: the write
    // is queued and the turn runs on. A failure ends the turn and is kept to
    // be thrown once the stream has closed (the AI SDK swallows what a
    // callback throws — verified: util/notify.ts `catch {}`). Answers whether
    // the write landed.
    const record = (lines: TranscriptLine[]): Promise<boolean> => {
      if (state.recordFailure) return Promise.resolve(false);
      for (const line of lines) if (line.type === 'message') tally.added.push(line.message);
      const write = input.record(lines).then(() => true, (error: unknown) => {
        if (!state.recordFailure) {
          state.recordFailure = asPhantomError(error, 'transcript_write_failed', 'recording the turn');
          abort.abort(state.recordFailure);
        }
        return false;
      });
      state.writes = state.writes.then(() => write.then(() => undefined));
      return write;
    };
    /** Every write made so far has landed (or failed). */
    const settled = async () => { await state.writes; throwIfFailed(state); };

    const result = streamText({
      model: input.model,
      instructions: input.system,
      messages: [...history, ...tally.added, ...state.drivers],
      tools: gated(input.tools, step, input.recordedByServer, (delta) => { serverToolsInFlight += delta; }),
      stopWhen: [
        ...(input.maxSteps == null ? [] : [stepCountIs(input.maxSteps)]),
        ...(input.terminal.length ? [hasToolCall(...input.terminal)] : []),
        () => { if (input.handoff()) handedOff = true; return handedOff; },
      ],
      maxRetries: 0,                       // retries are the fetch wrapper's, never stacked
      // The AI SDK's default onError is console.error — a second copy of a
      // failure the stream already delivers as its `error` part (read
      // below), printed over a host's screen. The part is the one report.
      onError: () => undefined,
      abortSignal: abort.signal,
      ...(input.reasoning ? { reasoning: input.reasoning } : {}),

      prepareStep: ({ messages, stepNumber }) => {
        step.reset();
        const more = input.pending().map(userMessage);
        if (more.length && stepNumber === 0) {
          // The run has not been answered yet: these open it with the rest.
          state.drivers.push(...more);
        } else if (more.length) {
          // The model is mid-run: these ride its next call, written now.
          void record(more.map(messageLine));
        }
        return { messages: withRollingCacheMark([...messages, ...more]) };
      },

      onLanguageModelCallEnd: (callEnd) => {
        // The model answered: the drivers (first call of the run), the
        // answer, its usage — queued for the record, not waited on.
        const assistant = assistantMessageFrom(callEnd.content);
        const callUsage = {
          provider: input.spec.provider, model: input.spec.model, responseId: callEnd.responseId,
          input: callEnd.usage.inputTokens ?? 0, output: callEnd.usage.outputTokens ?? 0,
          cacheRead: callEnd.usage.inputTokenDetails?.cacheReadTokens ?? 0,
          cacheWrite: callEnd.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
        };
        tally.usage.input += callUsage.input; tally.usage.output += callUsage.output;
        tally.usage.cacheRead += callUsage.cacheRead; tally.usage.cacheWrite += callUsage.cacheWrite;
        const drivers = state.drivers;
        state.drivers = [];
        state.unwritten.push(...drivers);
        const lines: TranscriptLine[] = [
          ...drivers.map(messageLine),
          ...(assistant ? [messageLine(assistant)] : []),
          usageLine(callUsage),
          ...step.held,
        ];
        step.held = [];
        step.assistantRecorded = true;
        step.written = record(lines).then((written) => {
          if (written) state.unwritten = state.unwritten.filter((message) => !drivers.includes(message));
        });
      },
    });

    try {
      for await (const raw of result.fullStream) {
        // Handed off mid tool calls: what the cut stream still emits — the
        // aborted calls reporting as tool errors, the abort itself — is the
        // cut's residue, not the turn's. Nobody hears it; the api finishes
        // those calls and the record carries their real results.
        if (handedOffMidTools) continue;
        const part = raw as KnownPart;
        switch (part.type) {
          case 'text-delta': step.text += (part as { text: string }).text; break;
          case 'tool-call': {
            const { toolCallId, toolName, input: args } = part as ToolCall;
            step.calls.push({ type: 'tool-call', toolCallId, toolName, input: args });
            break;
          }
          case 'tool-result':
          case 'tool-error': {
            const toolResult = part as ToolResult;
            const isError = toolResult.type === 'tool-error';
            if (isError) input.onToolError(toolResult.toolName, toolResult.error);
            step.answered.add(toolResult.toolCallId);
            if (!input.recordedByServer.has(toolResult.toolName)) {
              const line = messageLine(await toolResultMessage(toolResult, input.tools[toolResult.toolName], isError));
              if (step.assistantRecorded) void record([line]);
              else step.held.push(line);
            }
            if (!isError) failures.succeeded();
            else if (failures.failed(toolResult.toolName, toolResult.input) >= TOOL_FAILURE_LIMIT && !tripped) {
              tripped = new PhantomError('tool_loop',
                `${toolResult.toolName} failed ${TOOL_FAILURE_LIMIT} times in a row with the same input — the turn stopped`, { retryable: false });
              abort.abort(tripped);
            }
            break;
          }
          case 'finish-step': tally.text = step.text; break;
          case 'error': if (streamFailure === undefined) streamFailure = (part as { error: unknown }).error; break;
          default: break;
        }
        input.onPart(raw);
      }
    } catch (error) {
      // A stop closes the stream by throwing its reason out of the iteration,
      // or with an `abort` part. The cut step is recorded below; anything
      // else is the stream's own failure.
      if (!abort.signal.aborted) throw error;
    } finally {
      outer.removeEventListener('abort', onOuterAbort);
      offDisconnect();
    }
    // The stream's own promises resolve with the same outcome; settle them so
    // nothing is left dangling.
    await result.response.then(() => undefined, () => undefined);
    await settled();

    // Left mid tool calls: the record holds the call; the api writes the
    // results as the tools end, and the next driver starts after them.
    if (handedOffMidTools) return 'handed_off';

    if (abort.signal.aborted) {
      // The cut step. Nothing streamed = nothing to record beyond the
      // drivers that were sent and the mark.
      const lines: TranscriptLine[] = [];
      if (!step.assistantRecorded) {
        lines.push(...state.drivers.map(messageLine));
        const content: AssistantContent = [...(step.text ? [{ type: 'text' as const, text: step.text }] : []), ...step.calls];
        if (content.length) lines.push(messageLine({ role: 'assistant', content }));
        lines.push(...step.held);
      }
      // The server's open calls were cut with their requests: the api kills
      // those (the caller still held the session) and writes nothing, so the
      // placeholder is this side's for every unanswered call.
      for (const call of step.calls) if (!step.answered.has(call.toolCallId)) lines.push(messageLine(interruptedResultMessage(call)));
      lines.push(interruptedLine());
      state.unwritten.push(...state.drivers);
      state.drivers = [];
      if (await record(lines)) state.unwritten = [];
      await settled();
      if (tripped) throw tripped;
      if (step.text) tally.text = step.text;
      return 'stopped';
    }

    if (streamFailure !== undefined) {
      if (streamFailure instanceof PhantomError) throw streamFailure;
      const message = streamFailure instanceof Error ? streamFailure.message
        : typeof streamFailure === 'string' ? streamFailure : JSON.stringify(streamFailure);
      throw new PhantomError(isContextTooLong(message) ? 'context_too_long' : 'model_error', message, { cause: streamFailure, retryable: false });
    }
    // The condition is consulted only after a step with tool calls, so it
    // holding means the model has more to do and nothing here ended the run
    // — unless a terminal tool was among that step's calls, which ends the
    // turn whatever else was asked.
    if (handedOff && !step.calls.some((call) => input.terminal.includes(call.toolName))) return 'handed_off';
    return 'done';
  }
}

/** The tools, each gated: it runs once this step's assistant message landed
 *  in the record (the AI SDK starts tools after the model call ended, so the
 *  write is queued by then — this waits for it to land), so a result can
 *  never precede its call. Server tools also count themselves in flight. */
function gated(tools: Record<string, Tool>, step: StepInFlight, server: ReadonlySet<string>, inFlight: (delta: 1 | -1) => void): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool.execute) { out[name] = tool; continue; }
    const inner = tool.execute as (args: unknown, options: unknown) => unknown;
    out[name] = { ...tool, execute: async (args: unknown, options: unknown) => {
      await step.written;
      const counted = server.has(name);
      if (counted) inFlight(1);
      try { return await inner(args, options); }
      finally { if (counted) inFlight(-1); }
    } };
  }
  return out;
}

/** The text of a user message this turn made (`userMessage`). */
const userText = (message: ModelMessage): string =>
  typeof message.content === 'string' ? message.content
    : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
