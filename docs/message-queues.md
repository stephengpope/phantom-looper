# Message queues

How text reaches an agent's conversation, where each piece lives, and what
happens when a turn fails or is stopped.

## Two kinds of text

**Notes** are facts the system tells the agent: a git sync landed or
conflicted, a background command exited. They are not user messages.

**User messages** are words a person (or an automation acting as one) sent.

## Where each piece lives

| Piece | Lives in |
|---|---|
| The notes list (`SessionNotes`) | Server SDK — `phantom-agent-sdk/packages/backend/src/agents/SessionNotes.ts` |
| Adds a note when git finishes | Server SDK (`GitService`), wording from the server app (`syncNote` hook) |
| Adds a note when a command exits | Server SDK (`api/routes/fs.ts`) |
| Writes the notes into the conversation | Server SDK, `POST /sessions/:id/turn-start` |
| The user message queue | Client SDK — the `Agent`'s queue (`userMessages.ts`) |
| Riding vs driving, and when each is written | Client SDK — `turn.ts` |
| The `returned` event | Client SDK — `Agent` |
| Puts returned words back in the input box | Client app — `phantom-cli` (`sessions.ts`, `window.ts`) |
| Tells the chat "not sent" | Server app — `TelegramAssistantBot` |

The server app's engines (looper, crons, Telegram, the conflict fixer) run
turns through the client SDK too, over loopback. "Client SDK" means any
`Agent`, wherever it runs.

## Notes

A note waits in the server's list until the session's next turn starts.
Turn-start writes every waiting note into the conversation, ahead of the
turn's own words, under the turn's hold. Written, a note is part of the
conversation: it is never handed back, whatever the turn does next. A note
that arrives mid-turn waits for the next turn-start. The same note is not
added twice while one is waiting.

## User messages

`agent.sendMessage(text)`:

- **No turn running** — a turn starts with `text`. It is the turn's driver.
- **A turn running** — `text` is queued. The queue holds a person's words and
  nothing else.

Queued words reach the model one of two ways:

- **Riding.** The model is mid-run (it called tools and will be called
  again). The words join its next call. They are written to the conversation
  the moment they are taken, and never handed back.
- **Driving.** The model has stopped. The words open the next run — the same
  turn goes on, under the same hold. They are written with the model's first
  answer. If the run fails or is stopped before that answer, they were never
  written, and they come back on the `returned` event.

The agent keeps turning while words are queued: words that arrive after the
model's last look (while the turn is closing) drive one more turn instead of
waiting for the next message.

## `returned`

```ts
agent.on('returned', ({ texts, error }) => { /* never written: the app decides */ });
```

The one signal for words that did not make it. `error.code` says why
(`interrupted`, `session_locked`, `model_error`, …); a failure is also
reported once through `onError`. The SDK never re-queues returned words and
never retries them. The app decides: the cli puts them back in the input
box, ahead of anything typed since, and takes their line off the screen;
Telegram replies "not sent — send it again"; a headless engine can ignore it.

## Every case

| What happens | Kind | Result |
|---|---|---|
| You send while nothing runs | driving | The turn starts with it |
| You send while the model is mid-run | riding | Written, the model sees it on its next call |
| You send after the model stopped, turn still open | driving | The turn goes on with it |
| You send while the turn is closing | driving | One more turn starts with it |
| The first model call fails | driving | Comes back on `returned`, with the error |
| A run driven by queued words fails before an answer | driving | Comes back on `returned`, with the error |
| A later call fails after words rode in | riding | Already written — nothing to undo |
| Esc before the model was asked | driving | Comes back on `returned` (`interrupted`) |
| Esc after the model was asked | driving | Written with the cut step and an `interrupted` line |
| Esc with words queued | driving | The stop lands, then the turn goes on with them |
| The session is held elsewhere | driving | Comes back on `returned` (`session_locked`) |
| Git or a command finishes | note | Written at the next turn-start |
| The turn fails after notes were written | note | Already written — nothing to undo |
| `/pop` | — | Takes back only words still in the queue |

## Why it holds

- Anything written stays written. Nothing is ever put back into a queue.
- Only words that were never written can come back, so a failure cannot lose
  a message or write one twice.
- One owner per job: only the server SDK writes notes; only the client SDK's
  `Agent` decides riding vs driving; only an app decides how returned words
  are shown.
