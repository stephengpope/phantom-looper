// A minimal agent for the tests: a two-block prompt, one tool kit with a
// reader and a writer, and a scripted model in place of a provider.
import { tool, type LanguageModel } from 'ai';
import { z } from 'zod';
import { Agent, type AgentHandlers, type Notice, type SessionRow } from '../src/agent.js';
import { call, type PhantomBackend } from '../src/backend.js';
import type { PhantomError } from '../src/errors.js';
import type { ToolKit } from '../src/toolkit.js';
import { FakeBackend } from './fakeBackend.js';
import { scriptedModel, type ScriptedCall } from './fakeModel.js';

export const echoKit: ToolKit = {
  name: 'echo',
  mutatingToolNames: ['write_note'],
  version: () => 'v1',
  build: () => Promise.resolve({
    echo: tool({ description: 'echo', inputSchema: z.object({ text: z.string() }),
      execute: ({ text }) => Promise.resolve({ echoed: text }) }),
    write_note: tool({ description: 'write', inputSchema: z.object({ text: z.string() }),
      execute: ({ text }) => Promise.resolve({ wrote: text }) }),
    slow: tool({ description: 'slow', inputSchema: z.object({ ms: z.number() }),
      execute: ({ ms }, { abortSignal }) => new Promise((res, rej) => {
        const t = setTimeout(() => res({ slept: ms }), ms);
        abortSignal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); });
      }) }),
    fails: tool({ description: 'fails', inputSchema: z.object({ why: z.string().optional() }),
      execute: (): Promise<unknown> => Promise.reject(new Error('tool blew up')) }),
  }),
};

export class TestAgent extends Agent {
  readonly kind = 'coding';
  static script: ScriptedCall[] = [];
  static modelCalls: unknown[] = [];
  promptBuilds = 0;

  static create(backend: PhantomBackend, handlers: AgentHandlers, workspaceId = 'w1'): Promise<TestAgent> {
    return Agent.birth<TestAgent>(TestAgent, backend, handlers,
      () => call<SessionRow>(backend, 'POST', '/sessions', { workspace_id: workspaceId }));
  }
  static resume(backend: PhantomBackend, handlers: AgentHandlers, sessionId: string): Promise<TestAgent> {
    return Agent.wake<TestAgent>(TestAgent, backend, handlers, sessionId);
  }
  protected systemPrompt(): string[] { this.promptBuilds++; return ['BASE BLOCK', 'WORKSPACE BLOCK']; }
  protected toolKits(): ToolKit[] { return [echoKit]; }
  protected buildModel(): LanguageModel {
    const { model, calls } = scriptedModel(TestAgent.script);
    TestAgent.modelCalls = calls;
    return model;
  }
}

/** A subclass that rebuilds its prompt and config every turn. */
export class UnfrozenAgent extends TestAgent {
  protected override systemPromptFrozen = false;
  protected override llmConfigFrozen = false;
  static override create(backend: PhantomBackend, handlers: AgentHandlers, workspaceId = 'w1'): Promise<UnfrozenAgent> {
    return Agent.birth<UnfrozenAgent>(UnfrozenAgent, backend, handlers,
      () => call<SessionRow>(backend, 'POST', '/sessions', { workspace_id: workspaceId }));
  }
}

export interface Harness {
  fake: FakeBackend;
  errors: PhantomError[];
  notices: Notice[];
  handlers: AgentHandlers;
}

export function harness(): Harness {
  const fake = new FakeBackend();
  const errors: PhantomError[] = [];
  const notices: Notice[] = [];
  return { fake, errors, notices, handlers: { onError: (e) => errors.push(e), onNotice: (n) => notices.push(n) } };
}
