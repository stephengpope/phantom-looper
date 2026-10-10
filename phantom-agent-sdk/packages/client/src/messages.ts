// Messages as the record stores them, built from what the AI SDK streams.
// Mirrors the AI SDK's own `toResponseMessages` (ai/src/generate-text/
// to-response-messages.ts) so a message recorded here is byte-for-byte what
// the SDK would have put in `response.messages` — reasoning with its
// provider signature included, which Anthropic requires to replay a
// tool-use step.
import type { AssistantContent, AssistantModelMessage, Tool, ToolModelMessage, ToolResultPart } from 'ai';
import { messageLine, type MessageLine } from './transcript.js';

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
  for (const part of parts) {
    switch (part.type) {
      case 'text':
        if (part.text!.length) content.push({ type: 'text', text: part.text!, providerOptions: part.providerMetadata as never });
        break;
      case 'reasoning':
        content.push({ type: 'reasoning', text: part.text!, providerOptions: part.providerMetadata as never });
        break;
      case 'custom':
        content.push({ type: 'custom', kind: part.kind as `${string}.${string}`, providerOptions: part.providerMetadata as never } as never);
        break;
      case 'file':
        content.push({ type: 'file', data: part.file!.base64, mediaType: part.file!.mediaType, providerOptions: part.providerMetadata as never });
        break;
      case 'reasoning-file':
        content.push({ type: 'reasoning-file', data: part.file!.base64, mediaType: part.file!.mediaType, providerOptions: part.providerMetadata as never } as never);
        break;
      case 'tool-call':
        content.push({
          type: 'tool-call', toolCallId: part.toolCallId!, toolName: part.toolName!,
          input: part.invalid && typeof part.input !== 'object' ? {} : part.input,
          providerExecuted: part.providerExecuted, providerOptions: part.providerMetadata as never,
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

/** A SERVER tool's result as its record line — the one shaping for both
 *  sides: the client's kit (toModelOutput) and the backend, which writes
 *  the line itself when it ran the tool (api/routes/tools.ts). The envelope
 *  IS the result the model reads; an image read reaches it as an image. */
export function serverToolResultLine(call: { toolCallId: string; toolName: string }, envelope: unknown): MessageLine {
  const image = (envelope as { data?: { image?: { media_type: string; base64: string } } })?.data?.image;
  const output: ToolResultPart['output'] = image
    ? { type: 'content', value: [{ type: 'file', mediaType: image.media_type, data: { type: 'data', data: image.base64 } } as never] }
    : { type: 'json', value: envelope as never };
  return messageLine({ role: 'tool', content: [{ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output }] });
}

/** What a tool call whose result never arrived says in the record. The next
 *  turn must not take "no result" for "did not run". */
export const INTERRUPTED_RESULT =
  'interrupted before this call\'s result was read — it may or may not have run; check the state before repeating it.';

export function interruptedResultMessage(call: { toolCallId: string; toolName: string }): ToolModelMessage {
  return { role: 'tool', content: [{ type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName,
    output: { type: 'error-text', value: INTERRUPTED_RESULT } }] };
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try { return JSON.stringify(error); } catch { return String(error); }
}

function stripUndefined<T extends object>(object: T): T {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)) as T;
}
