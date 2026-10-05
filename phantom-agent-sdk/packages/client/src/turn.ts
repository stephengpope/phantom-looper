// One turn: the model is called, tools run, the model is called again, until
// it stops calling tools (or maxSteps). Then, if the user sent more while it
// ran, the same turn goes on with that text. A stop cuts the model loop it
// lands in; whether the turn goes on is the caller's (`afterStop`: the words
// to go on with, or none). One turn, one lock, one result, however many
// loops. ONE runner for every agent and every host. What differs by host is
// only where the parts go (`onPart`).
//
// What is recorded, and when (the record is the server's transcript):
//   model call succeeded  → the user messages that rode into it, the
//                            assistant message, the usage line — NOW, before
//                            any tool result (onLanguageModelCallEnd; the
//                            AI SDK awaits it and carries reasoning with its
//                            provider signature).
//   each tool finished    → its result, as it lands.
//   model call failed     → nothing from that step. The user messages that
//                            rode into it are handed back (`unsent`): the
//                            Agent puts them at the front of its queue, so
//                            they ride the next turn — or the host takes
//                            them back into its box.
//   interrupted           → partial text and every tool call seen, results
//                            for finished tools, INTERRUPTED_RESULT for the
//                            rest, then an `interrupted` line.
// A record that fails after retries STOPS the turn (transcript_write_failed).
// Nothing runs unrecorded.
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
  outcome: 'done' | 'interrupted';
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
  /** After a stopped loop: the words the turn goes on with, or none to end
   *  it as interrupted. */
  afterStop(): string[];
  /** What the turn opens with. */
  opening: string[];
  /** Called before every model call after the first, and once more when the
   *  model stops: the user messages that arrived since, taken. */
  pending(): string[];
  /** Append to the record. Rejects → the turn fails. */
  record(lines: TranscriptLine[]): Promise<void>;
  onPart(part: StreamPart): void;
  /** A tool answered with an error (the model still gets it). */
  onToolError(name: string, error: unknown): void;
  /** The loop failed with these user messages sent to the model and never
   *  recorded — the words are the caller's again. */
  unsent(texts: string[]): void;
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
  reset(): void { this.text = ''; this.calls = []; this.answered = new Set(); this.held = []; this.assistantRecorded = false; }
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
    const stopped = await runModelLoop(input, history, carry, tally);
    // Stopped: the caller says whether the turn goes on. Done: anything the
    // user sent meanwhile that did not ride a call continues this turn — the
    // reply the user is waiting for is to everything they said.
    carry = stopped ? input.afterStop() : input.pending();
    if (!carry.length) return { text: tally.text, messages: tally.added, usage: tally.usage, outcome: stopped ? 'interrupted' : 'done' };
  }
}

/** One model ↔ tools loop over `history + tally.added`, opening with
 *  `carry`. Resolves true when it was stopped. */
async function runModelLoop(input: TurnInput, history: readonly ModelMessage[], carry: string[], tally: Tally): Promise<boolean> {
  const outer = input.loopSignal();
  const abort = new AbortController();
  const onOuterAbort = () => abort.abort(outer.reason);
  if (outer.aborted) onOuterAbort();
  else outer.addEventListener('abort', onOuterAbort, { once: true });

  const step = new StepInFlight();
  // Set from the AI SDK's callbacks, read after the stream — a holder, so
  // the reads are not narrowed to their initial values.
  const state: { pendingMessages: ModelMessage[]; recordFailure: PhantomError | null } =
    { pendingMessages: carry.map(userMessage), recordFailure: null };
  try {
    return await streamModelLoop();
  } catch (error) {
    // The loop failed with the user's words unrecorded: they are the
    // caller's again. (A stop records them before it returns — see below.)
    if (state.pendingMessages.length) input.unsent(state.pendingMessages.map(userText));
    throw error;
  }

  async function streamModelLoop(): Promise<boolean> {
    let streamFailure: unknown;
    /** Set by the breaker: the stream is cut like a stop, the cut step
     *  recorded, then this is thrown instead of the stop's return. */
    let tripped: PhantomError | undefined;
    const failures = new RepeatedFailures();

    // Every record goes through here: a failure ends the turn and is kept to
    // be thrown once the stream has closed (the AI SDK swallows what a
    // callback throws — verified: util/notify.ts `catch {}`).
    const record = async (lines: TranscriptLine[]): Promise<void> => {
      if (state.recordFailure) return;
      try {
        await input.record(lines);
        for (const line of lines) if (line.type === 'message') tally.added.push(line.message);
      } catch (error) {
        state.recordFailure = asPhantomError(error, 'transcript_write_failed', 'recording the turn');
        abort.abort(state.recordFailure);
      }
    };

    // What is waiting rides the FIRST call as part of the initial messages
    // (the AI SDK refuses an empty list); prepareStep adds anything that
    // arrived since, and does the same before every later call.
    const drain = () => {
      const more = input.pending();
      if (more.length) state.pendingMessages = [...state.pendingMessages, ...more.map(userMessage)];
    };

    const result = streamText({
      model: input.model,
      instructions: input.system,
      messages: [...history, ...tally.added, ...state.pendingMessages],
      tools: input.tools,
      stopWhen: [
        ...(input.maxSteps == null ? [] : [stepCountIs(input.maxSteps)]),
        ...(input.terminal.length ? [hasToolCall(...input.terminal)] : []),
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
        // The first call's pending messages are already in `messages`.
        const before = stepNumber === 0 ? state.pendingMessages.length : 0;
        drain();
        return { messages: withRollingCacheMark([...messages, ...state.pendingMessages.slice(before)]) };
      },

      onLanguageModelCallEnd: async (callEnd) => {
        // The model answered: the messages that rode in, the answer, its usage.
        const assistant = assistantMessageFrom(callEnd.content);
        const callUsage = {
          provider: input.spec.provider, model: input.spec.model, responseId: callEnd.responseId,
          input: callEnd.usage.inputTokens ?? 0, output: callEnd.usage.outputTokens ?? 0,
          cacheRead: callEnd.usage.inputTokenDetails?.cacheReadTokens ?? 0,
          cacheWrite: callEnd.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
        };
        tally.usage.input += callUsage.input; tally.usage.output += callUsage.output;
        tally.usage.cacheRead += callUsage.cacheRead; tally.usage.cacheWrite += callUsage.cacheWrite;
        const lines: TranscriptLine[] = [
          ...state.pendingMessages.map(messageLine),
          ...(assistant ? [messageLine(assistant)] : []),
          usageLine(callUsage),
          ...step.held,
        ];
        step.held = [];
        step.assistantRecorded = true;
        state.pendingMessages = [];
        await record(lines);
      },
    });

    try {
      for await (const raw of result.fullStream) {
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
            const line = messageLine(await toolResultMessage(toolResult, input.tools[toolResult.toolName], isError));
            if (step.assistantRecorded) await record([line]);
            else step.held.push(line);
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
      // A stop closes the stream by throwing its reason out of the iteration
      // (verified against the AI SDK: no `abort` part follows). The cut step
      // is recorded below; anything else is the stream's own failure.
      if (!abort.signal.aborted) throw error;
    } finally {
      outer.removeEventListener('abort', onOuterAbort);
    }
    // The stream's own promises resolve with the same outcome; settle them so
    // nothing is left dangling.
    await result.response.then(() => undefined, () => undefined);

    throwIfFailed(state);

    if (abort.signal.aborted) {
      // The cut step. Nothing streamed = nothing to record beyond the user
      // messages that were sent and the mark.
      const lines: TranscriptLine[] = [];
      if (!step.assistantRecorded) {
        lines.push(...state.pendingMessages.map(messageLine));
        const content: AssistantContent = [...(step.text ? [{ type: 'text' as const, text: step.text }] : []), ...step.calls];
        if (content.length) lines.push(messageLine({ role: 'assistant', content }));
        lines.push(...step.held);
      }
      for (const call of step.calls) if (!step.answered.has(call.toolCallId)) lines.push(messageLine(interruptedResultMessage(call)));
      lines.push(interruptedLine());
      await record(lines);
      throwIfFailed(state);
      state.pendingMessages = [];   // recorded: no longer the caller's to take back
      if (tripped) throw tripped;
      if (step.text) tally.text = step.text;
      return true;
    }

    if (streamFailure !== undefined) {
      if (streamFailure instanceof PhantomError) throw streamFailure;
      const message = streamFailure instanceof Error ? streamFailure.message
        : typeof streamFailure === 'string' ? streamFailure : JSON.stringify(streamFailure);
      throw new PhantomError(isContextTooLong(message) ? 'context_too_long' : 'model_error', message, { cause: streamFailure, retryable: false });
    }
    return false;
  }
}

/** The text of a user message this turn made (`userMessage`). */
const userText = (message: ModelMessage): string =>
  typeof message.content === 'string' ? message.content
    : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
