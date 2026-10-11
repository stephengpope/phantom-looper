// One turn: the model is called, tools run, the model is called again, until
// it stops calling tools (or maxSteps). Then, if the user sent more while it
// ran, the same turn goes on with that text. A stop cuts the model loop it
// lands in; whether the turn goes on is the caller's (`afterStop`: the words
// to go on with, or none). One turn, one lock, one result, however many
// loops. ONE runner for every agent and every host. What differs by host is
// only where the parts go (`onPart`).
//
// THE RECORD IS THE API'S TO WRITE, one whole step at a time. This side
// never writes a line. It hands the api each STEP as it happens:
//
//   model call answered → `step`: the words that drove the call, the
//                         assistant message, its usage, the calls it made.
//                         The api holds it until every call is answered
//                         (or writes it at once when the answer made none).
//   a tool answered     → `result`, for a result drawn HERE (this side's
//                         kit, a refusal, a request that never reached the
//                         api). A server tool the api ran filed its own
//                         (`filed`): nothing to send.
//   stopped             → `close`: the api writes the cut step — the text
//                         as far as it got, the calls seen, the results in
//                         hand, interrupted for the rest, an `interrupted`
//                         line — in one write. Nothing was written before.
//   handed off          → nothing more. At a STEP BOUNDARY (every result in,
//                         the step written) `handoff()` is a stop condition.
//                         MID TOOL CALLS (server tools running) the turn
//                         hands off at once (`handoffNow`): the loop is cut;
//                         the api holds the step, finishes its tools, writes
//                         it, and the next driver starts after that.
//
// Every call to the api goes out in order on one chain; a tool runs only
// once the api holds the step that made the call. A call that fails STOPS
// the turn (transcript_write_failed) — nothing runs unrecorded. The words
// of a model run that failed before the api took its answer were never
// written: they are handed back (`unsent`).
import { streamText, stepCountIs, hasToolCall, type AssistantContent, type LanguageModel, type ModelMessage, type SystemModelMessage,
  type TextStreamPart, type Tool, type ToolCallPart, type ToolModelMessage } from 'ai';
import { PhantomError, asPhantomError } from './errors.js';
import { isContextTooLong } from './model/languageModel.js';
import { withRollingCacheMark } from './model/cache.js';
import type { ModelSpec, Reasoning } from './model/llmConfig.js';
import { assistantMessageFrom, toolResultMessage } from './messages.js';
import { userMessage, type TokenTotals, type TokenUsage, type TranscriptLine } from './transcript.js';

/** One part of the model stream, as the AI SDK emits it. Apps see every
 *  part (`onPart`); the turn reads the six it records from. */
export type StreamPart = TextStreamPart<Record<string, Tool>>;
type ToolCall = { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown };
type ToolResult = { type: 'tool-result' | 'tool-error'; toolCallId: string; toolName: string; input: unknown; output?: unknown; error?: unknown };
type KnownPart = { type: 'text-delta'; text: string } | ToolCall | ToolResult
  | { type: 'finish-step' } | { type: 'error'; error: unknown } | { type: string };

/** A call the model made, named to the api. */
export interface StepCall { toolCallId: string; toolName: string }
/** The model's answer, handed to the api. `usage` is absent for an answer
 *  cut before the call ended. */
export interface StepOpening { drivers: ModelMessage[]; assistant: ModelMessage | null; usage?: TokenUsage; calls: StepCall[] }
/** A result drawn on this side, handed to the api. */
export interface StepResult { toolCallId: string; toolName: string; message: ToolModelMessage }
/** What the api wrote: the lines, and the record after them. */
export interface Written { lines: TranscriptLine[]; count: number; updated_at: string }

export interface TurnResult {
  /** The final reply text (the last step's). */
  text: string;
  /** Every message this turn added to the conversation, in order. */
  messages: ModelMessage[];
  usage: TokenTotals;
  /** `handed_off`: the turn stopped for another driver to go on with
   *  (TurnInput.handoff / handoffNow); the record is the api's to finish. */
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
   *  caller's copy may grow as steps land; the turn reads it once. */
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
   *  (they drive the next step) and once more when the model stops (they
   *  drive the next run). */
  pending(): string[];
  /** Hand the api a step: the model's answer. Resolves once the api holds
   *  it — written when the answer made no call. Rejects → the turn fails. */
  step(opening: StepOpening): Promise<Written | null>;
  /** Hand the api a result drawn here. Resolves with the write when it was
   *  the step's last. */
  result(result: StepResult): Promise<Written | null>;
  /** The loop stopped: the api closes the step. `opening` is the answer the
   *  api never got (cut mid reply), null when it holds it already. */
  close(opening: StepOpening | null): Promise<Written | null>;
  /** The api wrote a step: file it. */
  onWritten(written: Written): void;
  /** Call ids whose results the api filed itself (it ran the tool and
   *  answered): the turn sends nothing for these. */
  filed: ReadonlySet<string>;
  onPart(part: StreamPart): void;
  /** A tool answered with an error (the model still gets it). */
  onToolError(name: string, error: unknown): void;
  /** A run failed before the api took its drivers: those words are the
   *  caller's again. */
  unsent(texts: string[]): void;
  /** Asked after every step whose tool calls all landed: true ends the turn
   *  there as `handed_off` — the model is not called again here. A step that
   *  ended the run on its own (the model stopped, a terminal tool) is done,
   *  whatever this says. */
  handoff(): boolean;
  /** Hear a disconnect the moment it is asked (the turn may hand off at once
   *  while server tools run). Answers the unsubscribe. */
  onDisconnect(listener: () => void): () => void;
  /** Hand the turn off NOW, mid tool calls: true when a runner took it — the
   *  loop is cut and the turn ends `handed_off` (the api finishes the step);
   *  false to go on here. */
  handoffNow(): Promise<boolean>;
  /** Tools the api runs (its own, through the tool route): what a
   *  disconnect can leave to it. */
  serverTools: ReadonlySet<string>;
}

/** The step in flight, from its parts: text, tool calls, results. Used for
 *  the cut step — a stop closes the stream before the model call ends —
 *  and to know which calls still owe a result. */
class StepInFlight {
  text = '';
  calls: ToolCallPart[] = [];
  answered = new Set<string>();
  /** The api holds this step's answer (the `step` call landed): a tool runs after. */
  opened: Promise<unknown> | null = null;
  reset(): void { this.text = ''; this.calls = []; this.answered = new Set(); this.opened = null; }
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

/** The api failure, if one landed during the callbacks. Read through a
 *  function: the field is set from AI SDK callbacks, which TypeScript cannot
 *  see, so an inline read is narrowed to its initial null. */
function throwIfFailed(state: { failure: PhantomError | null }): void {
  if (state.failure) throw state.failure;
}

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const tally: Tally = { added: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, text: '' };
  // The conversation as the turn found it. Steps land in the caller's copy
  // as the api writes them, so the loops below build from this snapshot
  // plus what the turn added — never from a copy that already holds the
  // additions.
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
  //   drivers   — the words the next model call opens with, not yet handed over
  //   unwritten — drivers handed to the api in a step not yet acknowledged
  //   chain     — every call to the api, in order: awaited once, before returning
  const state: { drivers: ModelMessage[]; unwritten: ModelMessage[]; chain: Promise<unknown>; failure: PhantomError | null } =
    { drivers: carry.map(userMessage), unwritten: [], chain: Promise.resolve(), failure: null };
  try {
    return await streamModelLoop();
  } catch (error) {
    // The run failed with its drivers never taken: they are the caller's
    // again. (A stop hands them over before it returns — see below.)
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
     *  it; the api owes the step. */
    let handedOffMidTools = false;
    let handingOff = false;
    /** Server tool calls running right now — what a disconnect can leave to the api. */
    let serverToolsInFlight = 0;
    /** Hand off now, if the turn is where it can: the api holds the step and
     *  a server tool is running (the api finishes it). Tried at the two
     *  moments that can newly hold — the disconnect itself, and a server tool
     *  starting when a hand-off is pending. A disconnect that lands mid reply
     *  is nothing to act on yet; the next tool start is where it takes. */
    const handoffNow = () => {
      if (handingOff || !step.opened || serverToolsInFlight === 0) return;
      handingOff = true;
      void input.handoffNow().then((taken) => {
        if (taken) { handedOffMidTools = true; abort.abort(new Error('handed off')); }
        else handingOff = false;
      });
    };
    const offDisconnect = input.onDisconnect(handoffNow);
    /** Set by the breaker: the stream is cut like a stop, the cut step
     *  closed, then this is thrown instead of the stop's return. */
    let tripped: PhantomError | undefined;
    const failures = new RepeatedFailures();

    // Every call to the api goes through here, in order, without waiting:
    // the call is queued and the turn runs on. A failure ends the turn and
    // is kept to be thrown once the stream has closed (the AI SDK swallows
    // what a callback throws — verified: util/notify.ts `catch {}`). What
    // the api wrote is filed as it answers.
    const send = (call: () => Promise<Written | null>): Promise<boolean> => {
      if (state.failure) return Promise.resolve(false);
      const made = state.chain.then(call).then((written) => {
        if (written) {
          for (const line of written.lines) if (line.type === 'message') tally.added.push(line.message);
          input.onWritten(written);
        }
        return true;
      }, (error: unknown) => {
        if (!state.failure) {
          state.failure = asPhantomError(error, 'transcript_write_failed', 'recording the turn');
          abort.abort(state.failure);
        }
        return false;
      });
      state.chain = made;
      return made;
    };
    /** Every call made so far has landed (or failed). */
    const settled = async () => { await state.chain; throwIfFailed(state); };

    const result = streamText({
      model: input.model,
      instructions: input.system,
      messages: [...history, ...tally.added, ...state.drivers],
      tools: gated(input.tools, step, input.serverTools, (delta) => { serverToolsInFlight += delta; if (delta > 0 && input.handoff()) handoffNow(); }),
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

      prepareStep: ({ messages }) => {
        step.reset();
        // Words that arrived since the last call ride this one: they drive
        // it, and go to the api with its answer.
        const more = input.pending().map(userMessage);
        state.drivers.push(...more);
        return { messages: withRollingCacheMark([...messages, ...more]) };
      },

      onLanguageModelCallEnd: (callEnd) => {
        // The model answered: the step goes to the api — the drivers, the
        // answer, its usage, the calls — queued, not waited on.
        const assistant = assistantMessageFrom(callEnd.content);
        const callUsage: TokenUsage = {
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
        const calls = callsOf(assistant, input.tools);
        step.opened = send(() => input.step({ drivers, assistant, usage: callUsage, calls })).then((taken) => {
          if (taken) state.unwritten = state.unwritten.filter((message) => !drivers.includes(message));
        });
      },
    });

    try {
      for await (const raw of result.fullStream) {
        // Handed off mid tool calls: what the cut stream still emits — the
        // aborted calls reporting as tool errors, the abort itself — is the
        // cut's residue, not the turn's. Nobody hears it; the api finishes
        // the step.
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
            // A result the api filed itself needs no sending; any other —
            // this side's kit, a refusal, a request that never got there —
            // is this side's to hand over.
            if (!input.filed.has(toolResult.toolCallId)) {
              const tool = input.tools[toolResult.toolName];
              void send(async () => input.result({ toolCallId: toolResult.toolCallId, toolName: toolResult.toolName,
                message: await toolResultMessage(toolResult, tool, isError) }));
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
      // or with an `abort` part. The cut step is closed below; anything else
      // is the stream's own failure.
      if (!abort.signal.aborted) throw error;
    } finally {
      outer.removeEventListener('abort', onOuterAbort);
      offDisconnect();
    }
    // The stream's own promises resolve with the same outcome; settle them so
    // nothing is left dangling.
    await result.response.then(() => undefined, () => undefined);
    await settled();

    // Left mid tool calls: the api holds the step and finishes it; the next
    // driver starts after that.
    if (handedOffMidTools) return 'handed_off';

    if (abort.signal.aborted) {
      // The cut step: the api closes it with the truth — what the model had
      // said, the results in hand, interrupted for the rest. The answer the
      // api never got (cut mid reply) goes with the close.
      const drivers = state.drivers;
      state.drivers = [];
      state.unwritten.push(...drivers);
      const opened = step.opened !== null;
      const content: AssistantContent = [...(step.text ? [{ type: 'text' as const, text: step.text }] : []), ...step.calls];
      const opening: StepOpening | null = opened ? null
        : { drivers, assistant: content.length ? { role: 'assistant', content } : null, calls: step.calls.map(({ toolCallId, toolName }) => ({ toolCallId, toolName })) };
      if (await send(() => input.close(opening))) state.unwritten = [];
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

/** The calls an answer made that will be answered: every tool-call part
 *  for a tool this side can run (the AI SDK runs those; a call to a tool
 *  with no executor gets no result and is not waited for). */
function callsOf(assistant: ModelMessage | null, tools: Record<string, Tool>): StepCall[] {
  if (!assistant || typeof assistant.content === 'string') return [];
  return assistant.content
    .filter((part): part is ToolCallPart => part.type === 'tool-call' && !!tools[part.toolName]?.execute)
    .map(({ toolCallId, toolName }) => ({ toolCallId, toolName }));
}

/** The tools, each gated: it runs once the api holds this step's answer
 *  (the AI SDK starts tools after the model call ended, so the `step` call
 *  is queued by then — this waits for it to land), so a result can never
 *  reach the api before its call. Server tools also count themselves in
 *  flight — counted AFTER the call went out, so whoever acts on the count
 *  (a hand-off) acts on a request the api has. */
function gated(tools: Record<string, Tool>, step: StepInFlight, server: ReadonlySet<string>, inFlight: (delta: 1 | -1) => void): Record<string, Tool> {
  const out: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!tool.execute) { out[name] = tool; continue; }
    const inner = tool.execute as (args: unknown, options: unknown) => unknown;
    out[name] = { ...tool, execute: async (args: unknown, options: unknown) => {
      await step.opened;
      const counted = server.has(name);
      const running = inner(args, options);
      if (counted) inFlight(1);
      try { return await running; }
      finally { if (counted) inFlight(-1); }
    } };
  }
  return out;
}

/** The text of a user message this turn made (`userMessage`). */
const userText = (message: ModelMessage): string =>
  typeof message.content === 'string' ? message.content
    : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
