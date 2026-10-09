// Concept checks for a turn hand-off between two drivers, against a mock
// model and the existing turn loop. Nothing here is the feature; each test
// proves one thing the feature rests on. Run: npm test in this package.
//
//   1. The step boundary exists in the AI SDK: a stop condition raised while
//      a tool runs ends the stream after that step, with the tool's result
//      in the response and no error — the model is not called again.
//   2. A conversation that ends in a tool result is a valid opening for the
//      next model call: no user message is needed to go on.
//   3. The existing runTurn continues such a record with an EMPTY opening:
//      one model call, the reply recorded, no user line, outcome done.
//   4. What an abort writes today: the cut step and an `interrupted` line —
//      so a hand-off cannot ride the abort; it needs the stop condition.
//   5. runTurn's own hand-off: the condition raised while a tool runs ends
//      the turn `handed_off` after that step, the record whole and unmarked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamText, tool, jsonSchema, type ModelMessage, type LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { runTurn, type TurnInput } from './turn.js';
import type { TranscriptLine } from './transcript.js';

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const finish = (unified: 'stop' | 'tool-calls'): LanguageModelV4StreamPart =>
  ({ type: 'finish', usage: usage as never, finishReason: { unified, raw: unified } });

/** One model answer as a v4 stream. */
function answer(parts: LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue({ type: 'stream-start', warnings: [] });
      controller.enqueue({ type: 'response-metadata', id: `r-${Math.random().toString(36).slice(2)}`, modelId: 'mock' });
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}
const callsTool = (): LanguageModelV4StreamPart[] => [
  { type: 'tool-call', toolCallId: 'call-1', toolName: 'look', input: JSON.stringify({ at: 'x' }) }, finish('tool-calls'),
];
const saysText = (text: string): LanguageModelV4StreamPart[] => [
  { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, finish('stop'),
];

/** A model that answers each call from `answers`, in order, and keeps every prompt it saw. */
function mockModel(answers: LanguageModelV4StreamPart[][]): { model: LanguageModel; prompts: () => ModelMessage[][] } {
  const seen: ModelMessage[][] = [];
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      seen.push(options.prompt as unknown as ModelMessage[]);
      const next = answers.shift();
      if (!next) throw new Error('the model was called more times than the test allows');
      return { stream: answer(next) };
    },
  });
  return { model: model as unknown as LanguageModel, prompts: () => seen };
}

/** The one tool: answers `{ saw }`, and lets the test act while it runs. */
function lookTool(onRun: () => void = () => undefined) {
  return {
    look: tool({
      description: 'look at something',
      inputSchema: jsonSchema<{ at: string }>({ type: 'object', properties: { at: { type: 'string' } }, required: ['at'] }),
      execute: async ({ at }) => { onRun(); return { saw: at }; },
    }),
  };
}

test('1. a stop condition raised while a tool runs ends the stream after that step, result in, no error', async () => {
  let handoff = false;
  const { model, prompts } = mockModel([callsTool(), saysText('never')]);
  const result = streamText({
    model, tools: lookTool(() => { handoff = true; }),
    messages: [{ role: 'user', content: 'go' }],
    stopWhen: () => handoff,
    maxRetries: 0, onError: () => undefined,
  });
  const parts: string[] = [];
  for await (const part of result.fullStream) parts.push(part.type);
  const messages = (await result.response).messages;
  assert.equal(prompts().length, 1, 'the model is called once: the step ran, then the stop held');
  assert.ok(!parts.includes('error'));
  assert.ok(parts.includes('tool-result'));
  assert.equal(messages.at(-1)?.role, 'tool', 'the record ends with the tool result');
  assert.equal((await result.finishReason).unified ?? await result.finishReason, 'tool-calls');
});

test('2. a conversation ending in a tool result opens the next model call with no user message', async () => {
  const history: ModelMessage[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'look', input: { at: 'x' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'look', output: { type: 'json', value: { saw: 'x' } } }] },
  ];
  const { model, prompts } = mockModel([saysText('done')]);
  const result = streamText({ model, tools: lookTool(), messages: history, maxRetries: 0, onError: () => undefined });
  assert.equal(await result.text, 'done');
  const prompt = prompts()[0]!;
  assert.equal(prompt.at(-1)?.role, 'tool', 'the model saw the history as it stood, ending in the tool result');
});

/** runTurn over a mock model, recording into `lines`. */
function turnInput(model: LanguageModel, history: ModelMessage[], opening: string[], lines: TranscriptLine[], loopSignal?: () => AbortSignal): TurnInput {
  return {
    model, spec: { provider: 'openai', model: 'mock', baseUrl: null, reasoning: null, apiKey: 'k' },
    system: [], tools: lookTool(), terminal: [], history, maxSteps: null, reasoning: undefined,
    loopSignal: loopSignal ?? (() => new AbortController().signal),
    afterStop: () => [], opening, pending: () => [], handoff: () => false,
    record: async (added) => { lines.push(...added); },
    onPart: () => undefined, onToolError: () => undefined, unsent: () => undefined,
  };
}

test('3. runTurn continues a record ending in a tool result with an EMPTY opening: one call, reply recorded, no user line', async () => {
  const history: ModelMessage[] = [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'look', input: { at: 'x' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'look', output: { type: 'json', value: { saw: 'x' } } }] },
  ];
  const { model, prompts } = mockModel([saysText('done')]);
  const lines: TranscriptLine[] = [];
  const result = await runTurn(turnInput(model, history, [], lines));
  assert.equal(result.outcome, 'done');
  assert.equal(result.text, 'done');
  assert.equal(prompts().length, 1);
  assert.equal(prompts()[0]!.length, 3, 'the model saw the three history messages and nothing else');
  const recorded = lines.filter((line) => line.type === 'message').map((line) => line.message.role);
  assert.deepEqual(recorded, ['assistant'], 'only the reply was recorded — no user message was invented');
  assert.ok(lines.some((line) => line.type === 'usage'));
});

test('4. an abort during the tool step writes the cut step and an interrupted line — the hand-off cannot ride it', async () => {
  const abort = new AbortController();
  const { model } = mockModel([callsTool(), saysText('never')]);
  const lines: TranscriptLine[] = [];
  const input = turnInput(model, [], ['go'], lines, () => abort.signal);
  // Stop as soon as the tool is about to run: the step is cut under it.
  input.tools = lookTool(() => abort.abort());
  const result = await runTurn(input);
  assert.equal(result.outcome, 'interrupted');
  assert.ok(lines.some((line) => line.type === 'interrupted'), 'an interrupted line is written');
  const toolLines = lines.filter((line) => line.type === 'message' && line.message.role === 'tool');
  assert.ok(toolLines.length >= 1, 'the unanswered call gets a result (the interrupted placeholder or the real one)');
});

test('5. runTurn hands off at the step boundary: the tool result recorded, no interrupted line, the model not called again', async () => {
  let handoff = false;
  const { model, prompts } = mockModel([callsTool(), saysText('never')]);
  const lines: TranscriptLine[] = [];
  const input = turnInput(model, [], ['go'], lines);
  input.handoff = () => handoff;
  input.tools = lookTool(() => { handoff = true; });
  const result = await runTurn(input);
  assert.equal(result.outcome, 'handed_off');
  assert.equal(prompts().length, 1);
  const roles = lines.filter((line) => line.type === 'message').map((line) => line.message.role);
  assert.deepEqual(roles, ['user', 'assistant', 'tool'], 'the drivers, the call and its result — whole');
  assert.ok(!lines.some((line) => line.type === 'interrupted'));
});

test('6. a hand-off asked during a text-only reply is not a hand-off: the turn is done', async () => {
  const { model } = mockModel([saysText('all done')]);
  const lines: TranscriptLine[] = [];
  const input = turnInput(model, [], ['go'], lines);
  input.handoff = () => true;
  const result = await runTurn(input);
  assert.equal(result.outcome, 'done');
  assert.equal(result.text, 'all done');
});
