// Concept checks for a turn's steps and its hand-off between two drivers,
// against a mock model, the real turn loop and a fake api that writes steps
// the way agents/Steps.ts does: a step is held until every call it made is
// answered, then written whole; a close writes it with the truth. Nothing
// here is the feature; each test proves one thing it rests on. Run: npm
// test in this package.
//
//   1. The step boundary exists in the AI SDK: a stop condition raised while
//      a tool runs ends the stream after that step, with the tool's result
//      in the response and no error — the model is not called again.
//   2. A conversation that ends in a tool result is a valid opening for the
//      next model call: no user message is needed to go on.
//   3. runTurn continues such a record with an EMPTY opening: one model
//      call, the reply written, no user line, outcome done.
//   4. A stop during the tool step: the api closes the step — the call, its
//      result as interrupted, an `interrupted` line — in one write.
//   5. runTurn's own hand-off: the condition raised while a tool runs ends
//      the turn `handed_off` after that step, the record whole and unmarked.
//   7–10. Server tools: the api files their results; a disconnect mid call
//      hands off at once; a result drawn here for a server tool (a refusal)
//      is sent, so the step is never left with a call unanswered.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { streamText, tool, jsonSchema, type ModelMessage, type LanguageModel, type ToolModelMessage } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider';
import { runTurn, type TurnInput, type StepOpening, type StepResult, type Written } from './turn.js';
import { messageLine, usageLine, interruptedLine, type TranscriptLine } from './transcript.js';
import { interruptedResultMessage } from './messages.js';

const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 5, text: 5, reasoning: 0 } };
const finish = (unified: 'stop' | 'tool-calls'): LanguageModelV4StreamPart =>
  ({ type: 'finish', usage: usage, finishReason: { unified, raw: unified } });

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
      seen.push(options.prompt);
      const next = answers.shift();
      if (!next) throw new Error('the model was called more times than the test allows');
      return { stream: answer(next) };
    },
  });
  return { model: model, prompts: () => seen };
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

/** The api's half, faked: one step held at a time, written whole into
 *  `lines` once every call is answered (or closed with the truth). */
function fakeApi(lines: TranscriptLine[]) {
  let open: { opening: StepOpening; results: Map<string, ToolModelMessage> } | null = null;
  const write = (opening: StepOpening, results: Map<string, ToolModelMessage>, end: 'interrupted' | null): Written => {
    const written: TranscriptLine[] = [
      ...opening.drivers.map(messageLine),
      ...(opening.assistant ? [messageLine(opening.assistant)] : []),
      ...(opening.usage ? [usageLine(opening.usage)] : []),
    ];
    for (const call of opening.calls) {
      const result = results.get(call.toolCallId) ?? (end ? interruptedResultMessage(call) : null);
      if (result) written.push(messageLine(result));
    }
    if (end) written.push(interruptedLine());
    lines.push(...written);
    open = null;
    return { lines: written, count: lines.length, updated_at: 'now' };
  };
  const settle = (): Written | null => {
    if (!open) return null;
    const whole = open.opening.calls.every((call) => open!.results.has(call.toolCallId));
    return whole ? write(open.opening, open.results, null) : null;
  };
  const file = (toolCallId: string, message: ToolModelMessage) => { if (open && !open.results.has(toolCallId)) open.results.set(toolCallId, message); };
  return {
    isOpen: () => open !== null,
    step: async (opening: StepOpening): Promise<Written | null> => { open = { opening, results: new Map() }; return settle(); },
    result: async (result: StepResult): Promise<Written | null> => { file(result.toolCallId, result.message); return settle(); },
    close: async (opening: StepOpening | null): Promise<Written | null> => {
      if (!open) { if (!opening) return null; open = { opening, results: new Map() }; }
      return write(open.opening, open.results, 'interrupted');
    },
    /** A server tool ran at the api: its result filed there. */
    serverResult: (toolCallId: string, toolName: string, output: unknown): Written | null => {
      file(toolCallId, { role: 'tool', content: [{ type: 'tool-result', toolCallId, toolName, output: { type: 'json', value: output as never } }] });
      return settle();
    },
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

/** runTurn over a mock model, handing steps to a fake api that writes into `lines`. */
function turnInput(model: LanguageModel, history: ModelMessage[], opening: string[], lines: TranscriptLine[], loopSignal?: () => AbortSignal): TurnInput & { api: ReturnType<typeof fakeApi>; filed: Set<string> } {
  const api = fakeApi(lines);
  const filed = new Set<string>();
  return {
    api, filed,
    model, spec: { provider: 'openai', model: 'mock', baseUrl: null, reasoning: null, apiKey: 'k' },
    system: [], tools: lookTool(), terminal: [], history, maxSteps: null, reasoning: undefined,
    loopSignal: loopSignal ?? (() => new AbortController().signal),
    afterStop: () => [], opening, pending: () => [], handoff: () => false,
    serverTools: new Set<string>(), onDisconnect: () => () => undefined, handoffNow: async () => false,
    step: api.step, result: api.result, close: api.close, onWritten: () => undefined,
    onPart: () => undefined, onToolError: () => undefined, unsent: () => undefined,
  };
}

const roles = (lines: TranscriptLine[]) => lines.filter((line) => line.type === 'message').map((line) => line.message.role);

test('3. runTurn continues a record ending in a tool result with an EMPTY opening: one call, reply written, no user line', async () => {
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
  assert.deepEqual(roles(lines), ['assistant'], 'only the reply was written — no user message was invented');
  assert.ok(lines.some((line) => line.type === 'usage'));
  assert.deepEqual(result.messages.map((message) => message.role), ['assistant'], 'the turn answers what the api wrote');
});

test('4. a stop during the tool step: the api closes the step — the call, its result as interrupted, an interrupted line — in one write', async () => {
  const abort = new AbortController();
  const { model } = mockModel([callsTool(), saysText('never')]);
  const lines: TranscriptLine[] = [];
  const input = turnInput(model, [], ['go'], lines, () => abort.signal);
  // Stop as soon as the tool is about to run: the step is cut under it.
  input.tools = lookTool(() => abort.abort());
  const result = await runTurn(input);
  assert.equal(result.outcome, 'interrupted');
  assert.deepEqual(roles(lines), ['user', 'assistant', 'tool'], 'the drivers, the call, and the truth about its result');
  assert.equal(lines.at(-1)?.type, 'interrupted', 'an interrupted line closes it');
  assert.ok(!input.api.isOpen(), 'nothing is left open');
});

test('5. runTurn hands off at the step boundary: the tool result written, no interrupted line, the model not called again', async () => {
  let handoff = false;
  const { model, prompts } = mockModel([callsTool(), saysText('never')]);
  const lines: TranscriptLine[] = [];
  const input = turnInput(model, [], ['go'], lines);
  input.handoff = () => handoff;
  input.tools = lookTool(() => { handoff = true; });
  const result = await runTurn(input);
  assert.equal(result.outcome, 'handed_off');
  assert.equal(prompts().length, 1);
  assert.deepEqual(roles(lines), ['user', 'assistant', 'tool'], 'the drivers, the call and its result — whole');
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

test('7. a server tool: the api files its result, the turn sends none, and the tool runs only once the api holds the step', async () => {
  const { model } = mockModel([callsTool(), saysText('done')]);
  const lines: TranscriptLine[] = [];
  const input = turnInput(model, [], ['go'], lines);
  input.serverTools = new Set(['look']);
  let apiHeldStepWhenToolRan = false;
  const sent: string[] = [];
  const api = input.api;
  input.result = async (result) => { sent.push(result.toolCallId); return api.result(result); };
  input.tools = {
    look: tool({
      description: 'a server tool', inputSchema: jsonSchema<{ at: string }>({ type: 'object', properties: { at: { type: 'string' } } }),
      execute: async ({ at }, options) => {
        apiHeldStepWhenToolRan = api.isOpen();
        // The api ran it: the result is filed there, the call id marked filed.
        api.serverResult(options.toolCallId, 'look', { saw: at });
        input.filed.add(options.toolCallId);
        return { saw: at };
      },
    }),
  };
  const result = await runTurn(input);
  assert.equal(result.outcome, 'done');
  assert.ok(apiHeldStepWhenToolRan, 'the tool ran after the api took the step');
  assert.deepEqual(sent, [], 'the turn sent nothing for a result the api filed');
  assert.deepEqual(roles(lines), ['user', 'assistant', 'tool', 'assistant'], 'the step whole, then the reply');
});

test('8. disconnect mid server tool call: handoffNow takes it, the loop is cut, nothing is written — the api holds the step', async () => {
  const { model, prompts } = mockModel([callsTool(), saysText('never')]);
  const lines: TranscriptLine[] = [];
  let disconnect: (() => void) | null = null;
  let toolAborted = false;
  const input = turnInput(model, [], ['go'], lines);
  input.serverTools = new Set(['look']);
  input.onDisconnect = (listener) => { disconnect = listener; return () => undefined; };
  input.handoffNow = async () => true;
  input.tools = {
    look: tool({
      description: 'slow', inputSchema: jsonSchema<{ at: string }>({ type: 'object', properties: { at: { type: 'string' } } }),
      // A real server tool is a fetch: cut, it REJECTS with the abort — which
      // the AI SDK reports as a tool-error part.
      execute: (_args, options) => new Promise((_resolve, reject) => {
        options?.abortSignal?.addEventListener('abort', () => { toolAborted = true; reject(new Error('aborted')); });
        setTimeout(() => disconnect?.(), 20);   // the person disconnects while the tool runs
      }),
    }),
  };
  const seen: string[] = [];
  input.onPart = (part) => { seen.push(part.type); };
  const result = await runTurn(input);
  assert.equal(result.outcome, 'handed_off');
  assert.ok(toolAborted, 'the open call was cut with the loop');
  assert.ok(!seen.includes('tool-error') && !seen.includes('error') && !seen.includes('abort'), `the cut's residue reached the app: ${seen.join(',')}`);
  assert.equal(prompts().length, 1);
  assert.deepEqual(roles(lines), [], 'nothing written: the api holds the step and finishes it');
  assert.ok(input.api.isOpen(), 'the step is the api\'s now');
});

test('9. disconnect BEFORE the tool starts (mid reply): the server tool is started, then the turn hands off at once — not after the tool ends', async () => {
  const { model, prompts } = mockModel([callsTool(), saysText('never')]);
  const lines: TranscriptLine[] = [];
  let toolStarted = false;
  let toolAborted = false;
  let toolFinished = false;
  const input = turnInput(model, [], ['go'], lines);
  input.serverTools = new Set(['look']);
  // The disconnect landed while the model was still writing: nothing to hand
  // off yet, and the listener (fired then) had nothing to act on.
  input.handoff = () => true;
  input.onDisconnect = () => () => undefined;
  input.handoffNow = async () => true;
  input.tools = {
    look: tool({
      description: 'slow', inputSchema: jsonSchema<{ at: string }>({ type: 'object', properties: { at: { type: 'string' } } }),
      // A long server tool (a two-minute bash): the hand-off must not wait for it.
      execute: (_args, options) => new Promise((resolve, reject) => {
        toolStarted = true;
        options?.abortSignal?.addEventListener('abort', () => { toolAborted = true; reject(new Error('aborted')); });
        setTimeout(() => { toolFinished = true; resolve({ saw: 'late' }); }, 500);
      }),
    }),
  };
  const started = Date.now();
  const result = await runTurn(input);
  assert.equal(result.outcome, 'handed_off');
  assert.ok(toolStarted, 'the tool was started — the api owns it from here');
  assert.ok(toolAborted && !toolFinished, 'the loop was cut under the running tool; it did not run to its end here');
  assert.ok(Date.now() - started < 400, `handed off at once, not after the tool (${Date.now() - started}ms)`);
  assert.equal(prompts().length, 1);
  assert.deepEqual(roles(lines), [], 'nothing written: the api holds the step');
});

test('10. a server tool refused HERE (read-only) never reached the api: the turn sends that result, and the step is whole', async () => {
  const { model } = mockModel([callsTool(), saysText('done')]);
  const lines: TranscriptLine[] = [];
  const input = turnInput(model, [], ['go'], lines);
  input.serverTools = new Set(['look']);
  input.tools = {
    look: tool({
      description: 'a server tool, refused on this side', inputSchema: jsonSchema<{ at: string }>({ type: 'object', properties: { at: { type: 'string' } } }),
      execute: async () => ({ ok: false, error: { code: 'readonly', message: 'refused: look is off while this agent is read-only' } }),
    }),
  };
  const result = await runTurn(input);
  assert.equal(result.outcome, 'done');
  assert.deepEqual(roles(lines), ['user', 'assistant', 'tool', 'assistant'], 'the refusal is the call\'s result in the record');
  const refusal = lines.find((line) => line.type === 'message' && line.message.role === 'tool');
  assert.ok(JSON.stringify(refusal).includes('readonly'));
  assert.ok(!input.api.isOpen());
});
