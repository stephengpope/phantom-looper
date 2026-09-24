# phantom-server-sdk

What phantom-backend runs. Today: the user message queue.

## The user message queue

The one way the server puts a message in front of a session's AI. Background
tasks, instant sync, auto-push / auto-pull and cron all push here. Nothing
here starts a turn.

```ts
import { UserMessageQueue } from 'phantom-server-sdk';

const queue = new UserMessageQueue(sessionAccess);   // the backend's lock + transcript

await queue.add(sessionId, 'task 7 exited 0');   // lock free: written now. Held: waits.

// Where a turn ends — this replaces releasing the lock:
await queue.release(sessionId);
```

- Lock free → `add` takes the lock, writes the message into the transcript
  as a user message, releases.
- Lock held → the message waits. The holder ends its turn through
  `release`: write what is waiting, release the lock, then write again if
  anything arrived in between. Whoever takes the lock next reads a
  transcript that already has it. No message waits for a turn that may
  never come.
- The same text already waiting is not queued again.
- A write that fails leaves the messages queued.
- In memory: a message held across a server restart is lost.

`SessionAccess` is what the backend gives it: `tryLock`, `releaseLock`,
`appendTranscript`.

Not wired into phantom-backend yet.

## Develop

```
npm run server-sdk:test
npm run server-sdk:lint
npm run server-sdk:build
```
