# phantom-server-sdk

What phantom-backend runs. Today: the user message queue.

## The user message queue

The one way the server puts a message in front of a session's AI. Background
tasks, instant sync, auto-push / auto-pull and cron all push here. Nothing
here starts a turn.

```ts
import { UserMessageQueue } from 'phantom-server-sdk';

const queue = new UserMessageQueue({ appendTranscript });   // the backend's transcript write

queue.add(sessionId, 'task 7 exited 0');

// Where a session lock is taken, under that lock, before the taker runs:
await queue.drain(sessionId);
```

- `add` queues. `drain` writes what is waiting into the transcript as user
  messages.
- `drain` runs when a lock is taken — so the messages land right before the
  next turn reads the transcript. Nothing reads them sooner. The client SDK
  sees the transcript changed when it takes the lock and reloads it.
- The same text already waiting is not queued again.
- A write that fails leaves the messages queued.
- In memory: a message held across a server restart is lost.

Not wired into phantom-backend yet.

## Develop

```
npm run sdk:build          # once — this package imports the transcript line format from phantom-client-sdk
npm run server-sdk:test
npm run server-sdk:lint
npm run server-sdk:build
```
