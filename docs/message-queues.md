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
| Puts unanswered words back in the queue; the `returned` event | Client SDK — `Agent` |
| Shows them queued again, with a "not sent" note | Client app — `phantom-cli` (`sessions.ts`) |
| Tells the chat "not sent — send it again" | Server app — `TelegramAssistantBot` |

The server app's engines (looper, crons, Telegram, the conflict fixer) run
turns through the client SDK too, over loopback. "Client SDK" means any
`Agent`, wherever it runs.

## Notes

A note waits in the server's list until the session's next turn starts.
Turn-start writes every waiting note into the conversation, ahead of the
turn's own words, under the turn's hold. Written, a note is part of the
conversation: it never comes back, whatever the turn does next. A note that
arrives mid-turn waits for the next turn-start. The same note is not added
twice while one is waiting.

## User messages

`agent.sendMessage(text)`:

- **No turn running** — a turn starts with whatever is queued, then `text`.
  These are the turn's drivers.
- **A turn running** — `text` is queued. The queue holds a person's words and
  nothing else.

Queued words reach the model one of two ways:

- **Riding.** The model is mid-run (it called tools and will be called
  again). The words join its next call. They are written to the conversation
  the moment they are taken, and never come back.
- **Driving.** The model has stopped. The words open the next run — the same
  turn goes on, under the same hold. They are written with the model's first
  answer. If the run fails or is stopped before that answer, they were never
  written: they go back to the front of the queue and wait.

The agent keeps turning while words are queued: words that arrive after the
model's last look (while the turn is closing) drive one more turn instead of
waiting for the next message.

## Not sent

Words the model never answered go back to the FRONT of the queue, ahead of
anything queued since, and wait. Nothing retries on its own: the next message
takes them along (say "continue" to just resend them). `/pop` takes them back
into the box.

```ts
agent.on('returned', ({ texts, error }) => { /* back in the queue — show it */ });
```

The `returned` event says which words and why (`error.code`: `interrupted`,
`session_locked`, `model_error`, …); a failure is also reported once through
`onError`. The cli takes their line off the conversation, shows them as
queued again, and notes "not sent". Telegram closes its agent after each
turn, so it tells the chat to send them again.

## Every case

Example: you send A; while the agent works you type B, then C.

| What happens | Kind | Result |
|---|---|---|
| You send while nothing runs | driving | The turn starts with it |
| You send while the model is mid-run | riding | Written, the model sees it on its next call |
| You send after the model stopped, turn still open | driving | The turn goes on with it |
| You send while the turn is closing | driving | One more turn starts with it |
| The model fails before answering A | driving | A back in the queue ahead of B and C, "not sent" |
| B rode a call, then a later call fails | riding | B already written; C still queued |
| A run driven by queued words fails before an answer | driving | Back in the queue, "not sent" |
| Esc before the model was asked | driving | Back in the queue |
| Esc after the model was asked | driving | Written with the cut step and an `interrupted` line |
| Esc with words queued | driving | The stop lands, then the turn goes on with them |
| The session is held elsewhere | driving | Back in the queue, "not sent" |
| Git or a command finishes | note | Written at the next turn-start |
| The turn fails after notes were written | note | Already written — nothing to undo |
| `/pop` | — | Takes back only words still in the queue |

## Why it holds

- Anything written stays written; only words the model never saw go back to
  the queue. So a failure cannot lose a message or write one twice.
- Nothing retries on its own, so a failing model cannot loop.
- One owner per job: only the server SDK writes notes; only the client SDK's
  `Agent` decides riding vs driving and what goes back; only an app decides
  how "not sent" is shown.
