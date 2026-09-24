// A scripted language model: each model call plays the next script entry as
// a V4 stream — text, tool calls, or an error — so the turn runner is driven
// exactly the way a provider would, without a provider.
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';

export interface ScriptedCall {
  text?: string;
  reasoning?: string;
  tools?: { name: string; input: Record<string, unknown> }[];
  /** Emit this error part instead of finishing. */
  error?: unknown;
  /** Delay between chunks, ms — lets a test interrupt mid-stream. */
  chunkDelayMs?: number;
  usage?: { input: number; output: number };
}

let callSeq = 0;

export function scriptedModel(script: ScriptedCall[]) {
  const calls: unknown[] = [];
  const model = new MockLanguageModelV4({
    provider: 'fake', modelId: 'fake-1',
    // One-shot calls (the compaction summary) take the next entry as text.
    doGenerate: async (options) => {
      calls.push(options);
      const entry = script.shift();
      if (!entry) throw new Error('scripted model: no script entry for this call');
      if (entry.error !== undefined) throw entry.error instanceof Error ? entry.error : new Error('scripted failure');
      return {
        content: [{ type: 'text', text: entry.text ?? '' }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: { inputTokens: { total: entry.usage?.input ?? 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: entry.usage?.output ?? 10, text: undefined, reasoning: undefined } },
        warnings: [],
      };
    },
    doStream: async (options) => {
      calls.push(options);
      const entry = script.shift();
      if (!entry) throw new Error('scripted model: no script entry for this call');
      const n = ++callSeq;
      const parts: LanguageModelV4StreamPart[] = [
        { type: 'stream-start', warnings: [] },
        { type: 'response-metadata', id: `resp-${n}`, modelId: 'fake-1', timestamp: new Date(0) },
      ];
      if (entry.reasoning) {
        parts.push({ type: 'reasoning-start', id: `r${n}` }, { type: 'reasoning-delta', id: `r${n}`, delta: entry.reasoning },
          { type: 'reasoning-end', id: `r${n}`, providerMetadata: { fake: { signature: `sig-${n}` } } });
      }
      if (entry.text) {
        parts.push({ type: 'text-start', id: `t${n}` });
        for (const word of entry.text.split(/(?<= )/)) parts.push({ type: 'text-delta', id: `t${n}`, delta: word });
        parts.push({ type: 'text-end', id: `t${n}` });
      }
      for (const [i, t] of (entry.tools ?? []).entries()) {
        const id = `call-${n}-${i}`;
        parts.push({ type: 'tool-input-start', id, toolName: t.name },
          { type: 'tool-input-delta', id, delta: JSON.stringify(t.input) },
          { type: 'tool-input-end', id },
          { type: 'tool-call', toolCallId: id, toolName: t.name, input: JSON.stringify(t.input) });
      }
      if (entry.error !== undefined) {
        parts.push({ type: 'error', error: entry.error });
      } else {
        parts.push({ type: 'finish', finishReason: { unified: entry.tools?.length ? 'tool-calls' : 'stop', raw: undefined },
          usage: { inputTokens: { total: entry.usage?.input ?? 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: entry.usage?.output ?? 10, text: undefined, reasoning: undefined } } });
      }
      return { stream: entry.chunkDelayMs ? delayed(parts, entry.chunkDelayMs) : convertArrayToReadableStream(parts) };
    },
  });
  return { model, calls };
}

function delayed(parts: LanguageModelV4StreamPart[], ms: number): ReadableStream<LanguageModelV4StreamPart> {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      if (i >= parts.length) { controller.close(); return; }
      await new Promise((r) => setTimeout(r, ms));
      controller.enqueue(parts[i++]);
    },
  });
}
