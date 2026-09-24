// One turn: the model is called, tools run, the model is called again, until
// it stops calling tools (or maxSteps). ONE runner for every agent and every
// host. What differs by host is only where the parts go (`onPart`).
//
// What is recorded, and when (the record is the server's transcript):
//   model call succeeded  → the user messages that rode into it, the
//                            assistant message, the usage line — NOW, before
//                            any tool result (onLanguageModelCallEnd; the
//                            AI SDK awaits it and carries reasoning with its
//                            provider signature).
//   each tool finished    → its result, as it lands.
//   model call failed     → nothing from that step; the queued messages that
//                            rode into it go back to their queues.
//   interrupted           → partial text and every tool call seen, results
//                            for finished tools, INTERRUPTED_RESULT for the
//                            rest, then an `interrupted` line.
// A record that fails after retries STOPS the turn (transcript_write_failed).
// Nothing runs unrecorded.
import { streamText, stepCountIs, type LanguageModel, type ModelMessage, type SystemModelMessage,
  type Tool, type ToolCallPart } from 'ai';
import { PhantomError, asPhantomError, isContextTooLong } from './errors.js';
import { withRollingCacheMark } from './model/cache.js';
import type { Reasoning } from './model/llmConfig.js';
import { assistantMessageFrom, toolResultMessage, interruptedResultMessage, userMessage } from './messages.js';
import { messageLine, usageLine, interruptedLine, type TranscriptLine } from './transcript.js';

export type StreamPart = { type: string; [k: string]: unknown };

export interface TurnUsage { input: number; output: number; cacheRead: number; cacheWrite: number }

export interface TurnResult {
  /** The final reply text (the last step's). */
  text: string;
  /** Every message this turn added to the conversation, in order. */
  messages: ModelMessage[];
  usage: TurnUsage;
  outcome: 'done' | 'interrupted';
  /** Input tokens of the LAST model call — what compaction compares to the window. */
  lastInputTokens: number;
}

/** What rides into the next model call: drained from the queues. `commit`
 *  when the call succeeded, `restore` when it failed. */
export interface PendingMessages {
  texts: string[];
  commit(): void;
  restore(): void;
}

export interface TurnInput {
  model: LanguageModel;
  provider: string;
  modelId: string;
  system: SystemModelMessage[];
  tools: Record<string, Tool>;
  /** The conversation so far. Not mutated; the result carries the additions. */
  history: readonly ModelMessage[];
  maxSteps: number | null;
  reasoning: Reasoning | undefined;
  signal: AbortSignal;
  /** Called before EVERY model call: what is waiting in the queues. The
   *  first call carries the turn's own text. */
  pending(): PendingMessages;
  /** Append to the record. Rejects → the turn fails. */
  record(lines: TranscriptLine[]): Promise<void>;
  onPart(part: StreamPart): void;
  /** A tool answered with an error (the model still gets it). */
  onToolError(name: string, error: unknown): void;
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

/** The record failure, if one landed during the callbacks. Read through a
 *  function: the field is set from AI SDK callbacks, which TypeScript cannot
 *  see, so an inline read is narrowed to its initial null. */
function throwIfFailed(st: { recordFailure: PhantomError | null }): void {
  if (st.recordFailure) throw st.recordFailure;
}

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const abort = new AbortController();
  const onOuterAbort = () => abort.abort(input.signal.reason);
  if (input.signal.aborted) onOuterAbort();
  else input.signal.addEventListener('abort', onOuterAbort, { once: true });

  const added: ModelMessage[] = [];
  const usage: TurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let lastInputTokens = 0;
  let text = '';
  let streamFailure: unknown;
  const step = new StepInFlight();
  // Set from the AI SDK's callbacks, read after the stream — a holder, so
  // the reads are not narrowed to their initial values.
  const st: { pending: PendingMessages | null; pendingMessages: ModelMessage[]; recordFailure: PhantomError | null } =
    { pending: null, pendingMessages: [], recordFailure: null };

  // Every record goes through here: a failure ends the turn and is kept to
  // be thrown once the stream has closed (the AI SDK swallows what a
  // callback throws — verified: util/notify.ts `catch {}`).
  const record = async (lines: TranscriptLine[]): Promise<void> => {
    if (st.recordFailure) return;
    try {
      await input.record(lines);
      for (const l of lines) if (l.type === 'message') added.push(l.message);
    } catch (e) {
      st.recordFailure = asPhantomError(e, 'transcript_write_failed', 'recording the turn');
      abort.abort(st.recordFailure);
    }
  };

  // What is waiting rides the FIRST call as part of the initial messages
  // (the AI SDK refuses an empty list); prepareStep adds anything that
  // arrived since, and does the same before every later call.
  const drain = () => {
    const more = input.pending();
    if (!more.texts.length) return;
    const prev = st.pending;
    st.pending = prev
      ? { texts: [...prev.texts, ...more.texts], commit: () => { prev.commit(); more.commit(); }, restore: () => { prev.restore(); more.restore(); } }
      : more;
    st.pendingMessages = st.pending.texts.map(userMessage);
  };
  drain();

  const result = streamText({
    model: input.model,
    instructions: input.system,
    messages: [...input.history, ...st.pendingMessages],
    tools: input.tools,
    stopWhen: input.maxSteps == null ? () => false : stepCountIs(input.maxSteps),
    maxRetries: 0,                       // retries are the fetch wrapper's, never stacked
    abortSignal: abort.signal,
    ...(input.reasoning ? { reasoning: input.reasoning } : {}),

    prepareStep: ({ messages, stepNumber }) => {
      step.reset();
      // The first call's pending messages are already in `messages`.
      const before = stepNumber === 0 ? st.pendingMessages.length : 0;
      drain();
      return { messages: withRollingCacheMark([...messages, ...st.pendingMessages.slice(before)]) };
    },

    onLanguageModelCallEnd: async (e) => {
      // The model answered: the messages that rode in, the answer, its usage.
      const assistant = assistantMessageFrom(e.content);
      const u = {
        provider: input.provider, model: input.modelId, responseId: e.responseId,
        input: e.usage.inputTokens ?? 0, output: e.usage.outputTokens ?? 0,
        cacheRead: e.usage.inputTokenDetails?.cacheReadTokens ?? 0,
        cacheWrite: e.usage.inputTokenDetails?.cacheWriteTokens ?? 0,
      };
      usage.input += u.input; usage.output += u.output; usage.cacheRead += u.cacheRead; usage.cacheWrite += u.cacheWrite;
      lastInputTokens = u.input;
      const lines: TranscriptLine[] = [
        ...st.pendingMessages.map(messageLine),
        ...(assistant ? [messageLine(assistant)] : []),
        usageLine(u),
        ...step.held,
      ];
      step.held = [];
      step.assistantRecorded = true;
      st.pending?.commit();
      st.pending = null;
      st.pendingMessages = [];
      await record(lines);
    },
  });

  try {
    for await (const part of result.fullStream as AsyncIterable<StreamPart>) {
      switch (part.type) {
        case 'text-delta': step.text += typeof part.text === 'string' ? part.text : ''; break;
        case 'tool-call':
          step.calls.push({ type: 'tool-call', toolCallId: part.toolCallId as string, toolName: part.toolName as string, input: part.input });
          break;
        case 'tool-result':
        case 'tool-error': {
          const isError = part.type === 'tool-error';
          if (isError) input.onToolError(part.toolName as string, part.error);
          step.answered.add(part.toolCallId as string);
          const msg = await toolResultMessage(part as never, input.tools[part.toolName as string], isError);
          const line = messageLine(msg);
          if (step.assistantRecorded) await record([line]);
          else step.held.push(line);
          break;
        }
        case 'finish-step': text = step.text; break;
        case 'error': if (streamFailure === undefined) streamFailure = part.error; break;
        default: break;
      }
      input.onPart(part);
    }
  } finally {
    input.signal.removeEventListener('abort', onOuterAbort);
  }
  // The stream's own promises resolve with the same outcome; settle them so
  // nothing is left dangling.
  await result.response.then(() => undefined, () => undefined);

  if (st.recordFailure) st.pending?.restore();
  throwIfFailed(st);

  if (abort.signal.aborted) {
    // The cut step. Nothing streamed = nothing to record beyond the user
    // messages that were sent and the mark.
    const lines: TranscriptLine[] = [];
    if (!step.assistantRecorded) {
      lines.push(...st.pendingMessages.map(messageLine));
      const content: ModelMessage['content'] = [
        ...(step.text ? [{ type: 'text' as const, text: step.text }] : []), ...step.calls,
      ] as never;
      if ((content as unknown[]).length) lines.push(messageLine({ role: 'assistant', content: content }));
      lines.push(...step.held);
      st.pending?.commit();
    }
    for (const c of step.calls) if (!step.answered.has(c.toolCallId)) lines.push(messageLine(interruptedResultMessage(c)));
    lines.push(interruptedLine());
    await record(lines);
    throwIfFailed(st);
    return { text: step.text || text, messages: added, usage, outcome: 'interrupted', lastInputTokens };
  }

  if (streamFailure !== undefined) {
    st.pending?.restore();
    if (streamFailure instanceof PhantomError) throw streamFailure;
    const message = streamFailure instanceof Error ? streamFailure.message
      : typeof streamFailure === 'string' ? streamFailure : JSON.stringify(streamFailure);
    throw new PhantomError(isContextTooLong(message) ? 'context_too_long' : 'model_error', message, { cause: streamFailure, retryable: false });
  }

  return { text, messages: added, usage, outcome: 'done', lastInputTokens };
}
