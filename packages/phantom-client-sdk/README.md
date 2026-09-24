# phantom-client-sdk

Build and run agents against a phantom-backend. The plan and every decision
behind it: `docs/client-sdk.md` at the repo root.

```ts
import { CodingAgent } from 'phantom-client-sdk';

const backend = { url: 'http://localhost:4000/api', apiKey, clientId: 'my-window' };
const handlers = {
  onError: (e) => log.error({ code: e.code, err: e }, e.message),   // every error, once
  onNotice: (n) => log.warn(n.text),                                 // retries, cache, compaction
};

const agent = await CodingAgent.create(backend, handlers, { workspaceId });
// or: await CodingAgent.resume(backend, handlers, sessionId)

agent.on('part', (p) => render(p));          // every stream part, unbatched
agent.on('turn-end', (r) => console.log(r.text));

const result = await agent.say('add a login page');   // runs a turn
agent.say('and tests');        // while busy: rides the next model call
agent.inject('a background command exited: build #12 failed');   // a fact, never a turn
agent.interrupt();             // esc — finished tool calls keep their results
agent.setReadonly(() => planMode);            // asked at execute time
agent.use(myScreenToolKit);                   // client-defined tools, same interface
await agent.compact();                        // also automatic, per the frozen llm config
```

## What the base class guarantees

- The system prompt and the LLM config are built once at `create` and
  frozen on the session row. `resume` reads them back. Nothing is rebuilt.
  A subclass sets `systemPromptFrozen = false` / `llmConfigFrozen = false`
  to opt out — then they are resolved every turn and never saved.
- The transcript is append-only. Each step is saved the moment its model
  call succeeds, each tool result as it lands. A save that fails after
  retries stops the turn. Compaction appends one line; loading rebuilds.
- Every error reaches `onError` with a code from `ERROR_CODES`, then the
  awaited call rejects with the same error. Background work has one door
  and its failures reach `onError` too. The SDK installs no process-wide
  handlers.

## Write your own agent

```ts
class ReviewAgent extends Agent {
  readonly kind = 'review';
  protected systemPrompt() { return ['You review pull requests.', `Repo facts: ...`]; }
  protected toolKits() { return [workspaceToolKit, webToolKit]; }
  static create(backend, handlers, opts) {
    return Agent.birth<ReviewAgent>(ReviewAgent, backend, handlers,
      () => call(backend, 'POST', '/sessions', { workspace_id: opts.workspaceId }));
  }
  static resume(backend, handlers, id) { return Agent.wake<ReviewAgent>(ReviewAgent, backend, handlers, id); }
}
```

## Develop

```
npm run sdk:test    # tests against a fake backend and a scripted model
npm run sdk:lint    # no-floating-promises, no-empty — the rules that keep errors from being dropped
npm run sdk:build
```
