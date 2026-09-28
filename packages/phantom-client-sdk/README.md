# phantom-client-sdk

The agent runtime for a phantom-backend. It knows how to run a session's
agent correctly against the API — the turn, the shared transcript, the
session lock, the model, billing, tools — and nothing about any particular
agent. An app subclasses `Agent` with its own prompt and kits. Our agents
live in `core/agents/`.

```ts
import { Agent, call, workspaceToolKit, webToolKit } from 'phantom-client-sdk';

class ReviewAgent extends Agent {
  readonly kind = 'review';                     // → GET /agents/review/config, billed as 'review'
  protected systemPrompt() { return ['You review pull requests.']; }
  protected toolKits() { return [workspaceToolKit, webToolKit]; }
  static create(backend, handlers, opts) {
    return Agent.birth<ReviewAgent>(ReviewAgent, backend, handlers,
      () => call(backend, 'POST', '/sessions', { workspace_id: opts.workspaceId }));
  }
  static resume(backend, handlers, id) { return Agent.wake<ReviewAgent>(ReviewAgent, backend, handlers, id); }
}

const backend = { url: 'http://localhost:4000/api', apiKey, clientId: 'my-window' };
const handlers = { onError: (e) => log.error(e), onNotice: (n) => log.warn(n.text) };
const agent = await ReviewAgent.resume(backend, handlers, sessionId);

agent.on('part', (p) => render(p));            // every stream part
agent.on('turn-end', (r) => console.log(r.text));
await agent.sendUserMessage('review PR 12');   // nothing running: starts a turn
agent.sendUserMessage('and check the tests');  // a turn running: rides its next model call
agent.interrupt();                             // finished tool calls keep their results
agent.setReadonly(() => planMode);             // asked at execute time
agent.use(myScreenToolKit);                    // host-defined tools, same interface
```

## What the runtime guarantees

- **The turn** (`turn.ts`): model call → tools → model call until the model
  stops or `maxSteps`. One runner for every agent and every host.
- **The record**: the transcript is append-only and shared — other windows
  and the server write it too, one turn at a time under the session lock.
  Every turn first checks its copy is current and reads it again if someone
  else added to it (only the new lines are fetched). Each step is saved
  the moment its model call succeeds,
  each tool result as it lands. A save that fails after retries stops the
  turn. A failed model call writes nothing.
- **The lock**: taken for the turn and released after; the server renews
  it on the turn's own writes.
- **The prompt** is the subclass's: `systemPrompt()` is asked before every
  turn and nothing is stored here. A prompt saved on the session row is
  answered from the row.
- **The model** is never kept: every turn asks the server which model and
  key the session runs on.
- **User messages**: `sendUserMessage(text)` starts a turn when none is
  running; otherwise the text rides the next model call; still queued when
  the turn ends, it starts the next turn. After an interrupt nothing starts
  by itself — the host decides. Messages the server holds for a session are
  written into the transcript by the server; the runtime sees the change
  and reads again.
- **Tools**: kits answer `{ tools, mutating }`; mutating tools refuse while
  `readonly` is true. The workspace kit takes its definitions from the
  server (`GET /tools`).
- **Billing**: every model call is posted to `/log-tokens` under `kind`.
  `billedModel()` is the same handle for an app's one-shot call (a title, a
  commit message) — nothing calls a model unbilled.
- **Errors**: every one reaches `onError` with a code from `ERROR_CODES`,
  then the awaited call rejects with the same error. Background work has
  one door and its failures reach `onError` too. No process-wide handlers.

## Develop

```
npm run sdk:build
npm run sdk:lint    # no-floating-promises, no-empty — the rules that keep errors from being dropped
```

The SDK is proven one way: running against a real phantom-backend.
