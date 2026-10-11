# Telegram streaming

How a Telegram chat shows the turns of the session it is on, whoever drives them.

## The idea

A chat **watches** one session. In assistant mode that is the chat's assistant
session; in code mode it is the chat's active session. Everything that happens
on that session streams into the chat: a turn the bot's own agent runs, a turn
typed in a cli window, a turn a client runner finishes after a `/disconnect`, a
turn a cron placed. There is one path from a turn to the chat, and the bot's
own turns take it too. The bot renders nothing itself.

The session feed carries every part of a turn, whoever produced it. The record
(the transcript) is read between turns. The chat follows the same rule as the
cli.

## The data path

1. A driver runs a turn on the session and relays its parts to the api
   (`POST /sessions/:id/events`). A turn the api itself drives, or a server tool
   result the api writes, publishes on the same bus in-process.
2. `sessionEvents` in the api fans each event out to its subscribers. The chat's
   `SessionWatch` is one of them. Nothing in the chat's path opens an HTTP
   stream; it is all in-process in the api.
3. The watch turns the events into chat messages through a `ReplyBubble`.
4. When the turn's hold on the session is released, a bubble still open is
   finished from the record.

```
driver ──relay──▶ api: sessionEvents ──▶ SessionWatch ──▶ ReplyBubble ──▶ TelegramApi
                        ▲                     │
                 record (transcript) ◀────────┘  fallback at the hold's release
```

## The pieces

### `phantom-backend/telegram/watch.ts` — `SessionWatch`

One per chat. Subscribes to the session's events and handles them in order on
one chain.

- `turn-start`: reads the chat's `/stream` setting, decides whether this turn
  shows, opens a bubble. In `all` mode a message typed elsewhere is shown first
  as `💬 from <holder>: …`.
- `part`: appended to the bubble. A chat that joins mid-turn opens a bubble on
  the first part.
- `turn-end`: the bubble is finished with the text the stream carried, and
  spoken when the reply mode says so.
- `error`: the bubble is discarded; another driver's failure is said once.
- `transcript`: notes that a reply is owed, in case the stream never arrives.
- `lock` released: a bubble still open, or a reply owed, is finished from the
  record. This is the fallback. A driver's stream is best effort and can die
  mid-turn; the hold's release always arrives because the turn's end is retried
  until it lands.

The watch also keeps the typing indicator up for the whole turn.

`TelegramAssistantBot.syncWatch` points each chat's watch at the right session
when the mode or the session changes, and `reconcile` starts one for every
linked chat at boot. Both sessions are on the chat's row
(`telegram_chat_state`): the active session in code mode, the chat's own
assistant session in assistant mode.

### `phantom-agent-sdk/packages/backend/src/telegram/ReplyBubble.ts` — `ReplyBubble`

One turn's reply as the chat sees it. It knows nothing about sessions or
settings; it is fed parts and draws them.

The reply is a list of **blocks** in the order the turn produced them:

- a **text** segment,
- a **tool** call, drawn as one line with an elapsed counter, then a ✓,
- a **waiting** line at the end while nothing has arrived: the `...` dots before
  the first output, `💭 thinking` after a tool.

Every block is one chat message. Two rules give the chat its shape:

- The dots are a slot. The first text or tool line takes their message over, so
  the wait becomes the answer in place.
- A thinking line is closed with a ✓ when the model moves on, and the next block
  is a new message below it. A thinking line still open when the turn ends
  receives the reply.

One timer draws it. Every second each block's text is computed from the blocks
and compared with what its message says; only what differs is sent or edited, in
block order. One edit a second per message is Telegram's ceiling, so the dots
move at the tick and the tool counter steps every three seconds. A send or
edit that fails is logged and corrected by the next tick.

`finish(text)` posts the authoritative final text once (formatted to Telegram
entities, split under 4096 characters) into the last text or waiting block,
then sends the files the reply named. In voice mode the text is not typed;
`finish` answers it so the caller can speak it. `discard()` deletes a wait that
never became anything and keeps what was drawn.

The same object is the "dots while a voice note is synthesized" bubble: one that
is never written into and then discarded.

### `TelegramBot.startReplyBubble`

Builds a `ReplyBubble` the way this install replies: files delivered from the
session's workspace on its host, text withheld when `telegram_reply_mode` is
`voice`. `sendMessageForSession` (the `send_message` tool) uses the same bubble
with no placeholder, so a deliberate message arrives exactly as a reply would.

### `TelegramApi`

Every call has a deadline: 30 s for a call, 120 s for an upload. A hung socket
fails the call instead of holding everything behind it.

## `/stream`

Per chat, read at each turn's start.

| mode | what streams |
| --- | --- |
| `on` (default) | every turn's reply on the session the chat is on |
| `all` | the same, plus a message typed elsewhere, shown above its reply |
| `off` | only this bot's own turns |

## Words

- **watch**: a chat following a session.
- **reply bubble**: one turn's reply in the chat. The ported names `sink` and
  `waiting bubble` are gone.
- **delivery**: the files a reply names, located in the workspace and sent after
  the words.
- **hold**: the session's lock; its release is the fallback moment.

## Tests

- `ReplyBubble.test.ts`: dots taken by the first text; one line per tool call
  however many parts announce it; thinking after a result; the reply into the
  last slot; voice mode types nothing; no placeholder posts once, chunked;
  discard keeps what was drawn; a failed edit is corrected by the next tick.
- `TelegramApi.test.ts`: a call with no answer fails at the deadline.

Run in `phantom-agent-sdk/packages/backend`:

```
npm test
```

## History

- v0.1.98: the record became the fallback. Before it, the watch closed a bubble
  only on the stream's `turn-end`, so a thinking line never resolved when a
  driver's relay died mid-turn.
- v0.1.99: call deadlines on `TelegramApi`; the chat's assistant session is
  looked up in the database at boot.
- v0.1.100: the renderer rebuilt as `ReplyBubble` (one timer, blocks drawn by
  comparison, failures logged) replacing `sink.ts` and `bubble.ts`. Nothing
  visible changed except the dots moving once a second instead of every 600 ms.
  The chat's assistant session moved onto the chat's own row
  (`telegram_chat_state.assistant_session_id`, app migration 006): before, a
  restart took the newest assistant session the bot had opened — anyone's.
