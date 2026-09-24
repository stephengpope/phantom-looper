# phantom-client-sdk

Build and run agents against a phantom-backend.

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

const result = await agent.sendUserMessage('add a login page');   // nothing running: starts a turn
agent.sendUserMessage('and tests');   // a turn running: rides its next model call
agent.interrupt();             // esc — finished tool calls keep their results
agent.setReadonly(() => planMode);            // asked at execute time
agent.use(myScreenToolKit);                   // client-defined tools, same interface
await agent.compact();
```

## User messages

- `sendUserMessage(text)` — nothing running: starts a turn. A turn running:
  queued, and rides the next model call. Still queued when the turn ends:
  starts the next turn. A failed turn takes its messages with it — nothing
  is kept or sent again.
- Injections — user messages queued for the session while no turn ran (a
  background command finished, instant sync). Pulled at the start of every
  turn, ahead of the user's own; they never start a turn.
  `PHANTOM_PULL_USER_MESSAGE_QUEUE=off` stops the pull, for a program that
  handles them itself.

## What the base class guarantees

- The system prompt is built once at `create` and frozen on the session
  row. `resume` reads it back. A subclass sets `systemPromptFrozen = false`
  to opt out — then it is built every turn and never saved.
- The model is never kept: every turn asks the server which model and key
  the session runs on.
- The transcript is append-only and shared — other windows and the server
  write it too, one turn at a time. Every turn first checks it is current
  and reads it again if someone else added to it. Each step is saved the
  moment its model call succeeds, each tool result as it lands. A save that
  fails after retries stops the turn. Compaction appends one line; loading
  rebuilds.
- Which tools change things is each kit's word (`build` answers `{ tools,
  mutating }`); the workspace kit takes it from the server's tool list.
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
