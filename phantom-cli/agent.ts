// The TUI's side of the agent: runTurn — one turn of an agent built by
// core/llm (createAgent for the assembly; agents/coding for the prompt stack
// and kit). The UI only sees batched stream parts.
import type { AssistantContent, ModelMessage, ToolCallPart, ToolContent, ToolResultPart } from 'ai';
import type { StreamPart } from './state.js';
import type { Agent } from '../core/llm/createAgent.js';
import type { StepRecord } from '../core/llm/transcript.js';

export {
  createAgent, isAnthropicOAuth, withClaudeCodeIdentity, withCacheBreakpoints,
  CLAUDE_CODE_SYSTEM, PROVIDERS,
  type Agent, type Provider, type Reasoning, type ModelConfig,
} from '../core/llm/createAgent.js';
export { codingInstructions } from '../core/llm/agents/coding.js';
import { withCacheBreakpoints } from '../core/llm/createAgent.js';


// Deltas arrive many times per second; a setState per token is the classic
// Ink flicker. Buffer deltas and flush every FLUSH_MS (Nanocoder's rule);
// flush immediately on any non-delta part so ordering is preserved.
export const FLUSH_MS = 150;

export async function runTurn(
  agent: Agent,
  messages: ModelMessage[],
  onParts: (parts: StreamPart[]) => void,
  signal: AbortSignal,
  // Called as each step ends with that step's messages — the hook the
  // transcript writes from, so tool calls and their results hit disk while the
  // turn is still running instead of at the end of it.
  onStep?: (messages: ModelMessage[]) => void,
  // How long deltas may sit before the UI sees them. The conversation pane
  // wants the batching (FLUSH_MS); a consumer that feeds speech wants every
  // delta the moment it arrives (0 — still ordered: a non-delta part flushes
  // what is buffered ahead of it).
  flushMs = FLUSH_MS,
  // Where the turn is recorded (createAgent's usage seam): each step's
  // messages AND its usage line land through this — pass the transcript.
  record?: StepRecord,
): Promise<ModelMessage[]> {
  const result = await agent.stream({
    messages: withCacheBreakpoints(messages),
    abortSignal: signal,
    record,
    onStepEnd: (step) => onStep?.(step.response.messages as ModelMessage[]),
  });

  let buf: StreamPart[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    if (buf.length) { const b = buf; buf = []; onParts(b); }
  };

  // The step in flight, kept from the parts as they pass. The SDK records a
  // step only when it ends (onStepEnd); an interrupt closes the stream with
  // an `abort` part and never ends the step — but its tool calls already RAN
  // in the container (a call is dispatched the moment it streams in; esc
  // kills it, and a short one has finished before the kill lands). Dropping
  // the step left the next turn believing those commands never happened —
  // found live: a `git stash pop` cut by esc, then run again onto a tree
  // the first one had already restored. So the cut step is written like
  // any other, from what streamed: the text so far, every call, each result
  // that arrived, and INTERRUPTED_RESULT standing in for one that did not.
  const inflight = new InFlight();
  let aborted = false;

  try {
    for await (const part of result.stream) {
      buf.push(part);
      inflight.see(part);
      if (part.type === 'abort') aborted = true;
      const isDelta = part.type === 'text-delta' || part.type === 'reasoning-delta' || part.type === 'tool-input-delta';
      if (isDelta) { if (!timer) timer = setTimeout(flush, flushMs); }
      else flush();
    }
  } finally {
    flush();
  }
  if (aborted || signal.aborted) {
    const cut = inflight.messages();
    if (cut.length) {
      record?.appendStep(cut, undefined);
      record?.appendEvent?.({ type: 'interrupted' });
      onStep?.(cut);
    }
    return cut;
  }
  // Messages to append to history (assistant + tool messages for every step).
  return (await result.responseMessages) as ModelMessage[];
}

/** What a tool call whose result never streamed says in the record. The
 *  next turn must not take "no result" for "did not run". */
export const INTERRUPTED_RESULT =
  'interrupted: the turn was stopped (esc) before this call\'s result was read. ' +
  'The command was killed if it was still running, but a short one may already have finished — ' +
  'check the state before repeating it.';

/** The messages of the step the SDK has not closed yet, rebuilt from stream
 *  parts. Reasoning is left out: it needs the provider's signature to replay,
 *  and the record is about what was DONE. `finish-step` empties it — that
 *  step is the SDK's to record. */
class InFlight {
  private text = '';
  private calls: ToolCallPart[] = [];
  private results = new Map<string, ToolResultPart>();

  see(part: StreamPart): void {
    switch (part.type) {
      case 'text-delta': this.text += part.text; break;
      case 'tool-call':
        this.calls.push({ type: 'tool-call', toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
        break;
      case 'tool-result':
        this.results.set(part.toolCallId, {
          type: 'tool-result', toolCallId: part.toolCallId, toolName: part.toolName,
          output: typeof part.output === 'string'
            ? { type: 'text', value: part.output }
            : { type: 'json', value: part.output as never },
        });
        break;
      case 'tool-error':
        this.results.set(part.toolCallId, {
          type: 'tool-result', toolCallId: part.toolCallId, toolName: part.toolName,
          output: { type: 'error-text', value: String((part.error as Error)?.message ?? part.error) },
        });
        break;
      case 'finish-step':
        this.text = ''; this.calls = []; this.results = new Map();
        break;
      default: break;
    }
  }

  /** Empty when nothing streamed; otherwise the assistant message and, when
   *  it called tools, the tool message answering EVERY call — a call without
   *  a result is a request the provider rejects. */
  messages(): ModelMessage[] {
    const content: AssistantContent = [
      ...(this.text ? [{ type: 'text' as const, text: this.text }] : []),
      ...this.calls,
    ];
    if (!content.length) return [];
    const out: ModelMessage[] = [{ role: 'assistant', content }];
    if (this.calls.length) {
      const answers: ToolContent = this.calls.map((c) => this.results.get(c.toolCallId) ?? {
        type: 'tool-result' as const, toolCallId: c.toolCallId, toolName: c.toolName,
        output: { type: 'error-text' as const, value: INTERRUPTED_RESULT },
      });
      out.push({ role: 'tool', content: answers });
    }
    return out;
  }
}
