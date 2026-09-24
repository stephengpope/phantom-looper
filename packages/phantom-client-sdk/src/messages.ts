// Messages as the record stores them, built from what the AI SDK streams.
// Mirrors the AI SDK's own `toResponseMessages` (ai/src/generate-text/
// to-response-messages.ts) so a message recorded here is byte-for-byte what
// the SDK would have put in `response.messages` — reasoning with its
// provider signature included, which Anthropic requires to replay a
// tool-use step.
import type { AssistantContent, AssistantModelMessage, ModelMessage, Tool, ToolModelMessage, ToolResultPart } from 'ai';

type ContentPart = {
  type: string; text?: string; kind?: string; providerMetadata?: Record<string, unknown>;
  toolCallId?: string; toolName?: string; input?: unknown; invalid?: boolean; providerExecuted?: boolean;
  file?: { base64: string; mediaType: string };
};

/** The assistant message for one model call, from the call's content parts
 *  (onLanguageModelCallEnd). Tool results are not here — they are their
 *  own messages, written as each lands. */
export function assistantMessageFrom(parts: ReadonlyArray<ContentPart>): AssistantModelMessage | null {
  const content: AssistantContent = [];
  for (const p of parts) {
    switch (p.type) {
      case 'text':
        if (p.text!.length) content.push({ type: 'text', text: p.text!, providerOptions: p.providerMetadata as never });
        break;
      case 'reasoning':
        content.push({ type: 'reasoning', text: p.text!, providerOptions: p.providerMetadata as never });
        break;
      case 'custom':
        content.push({ type: 'custom', kind: p.kind as `${string}.${string}`, providerOptions: p.providerMetadata as never } as never);
        break;
      case 'file':
        content.push({ type: 'file', data: p.file!.base64, mediaType: p.file!.mediaType, providerOptions: p.providerMetadata as never });
        break;
      case 'reasoning-file':
        content.push({ type: 'reasoning-file', data: p.file!.base64, mediaType: p.file!.mediaType, providerOptions: p.providerMetadata as never } as never);
        break;
      case 'tool-call':
        content.push({
          type: 'tool-call', toolCallId: p.toolCallId!, toolName: p.toolName!,
          input: p.invalid && typeof p.input !== 'object' ? {} : p.input,
          providerExecuted: p.providerExecuted, providerOptions: p.providerMetadata as never,
        });
        break;
      default: break; // sources and provider-executed results are response-only
    }
  }
  if (!content.length) return null;
  return { role: 'assistant', content: content.map(stripUndefined) as AssistantContent };
}

/** One tool result as its own tool message. `output` is what the tool
 *  returned; `tool.toModelOutput` (image reads) shapes it when present. */
export async function toolResultMessage(
  part: { toolCallId: string; toolName: string; input: unknown; output?: unknown; error?: unknown },
  tool: Tool | undefined, isError: boolean,
): Promise<ToolModelMessage> {
  let output: ToolResultPart['output'];
  if (isError) {
    output = { type: 'error-text', value: errorText(part.error) };
  } else if (tool?.toModelOutput) {
    output = await tool.toModelOutput({ toolCallId: part.toolCallId, input: part.input, output: part.output });
  } else {
    output = typeof part.output === 'string' ? { type: 'text', value: part.output }
      : { type: 'json', value: (part.output === undefined ? null : part.output) as never };
  }
  return { role: 'tool', content: [{ type: 'tool-result', toolCallId: part.toolCallId, toolName: part.toolName, output }] };
}

/** What a tool call whose result never arrived says in the record. The next
 *  turn must not take "no result" for "did not run". pi writes "Operation
 *  aborted"; ours says what to do about it. */
export const INTERRUPTED_RESULT =
  'interrupted: the turn was stopped before this call\'s result was read. ' +
  'The command was killed if it was still running, but a short one may already have finished — ' +
  'check the state before repeating it.';

export function interruptedResultMessage(call: { toolCallId: string; toolName: string }): ToolModelMessage {
  return { role: 'tool', content: [{ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName,
    output: { type: 'error-text', value: INTERRUPTED_RESULT } }] };
}

export const userMessage = (content: string): ModelMessage => ({ role: 'user', content });

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try { return JSON.stringify(e); } catch { return String(e); }
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
