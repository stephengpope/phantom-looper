# phantom-backend/telegram/ — the bot

A headless client of this server, started after listen like the looper.
One authorized user, DM only, webhook only. Two modes on one account row:
`assistant` (home) and `code` (a plain message runs a coding turn on the
active session).

```
engine.ts          TelegramEngine: reconcile (webhook + menus), handleUpdate (the webhook's fast ack), run (one
                   message: reply-switch → command → input → turn), assistantTurn, codeTurn, switchSession,
                   enterMode, the auto build alert listener, autoPush / autoPull for the commands
commands.ts        the slash commands and the per-mode menus; stepBubble for /auto_push and /auto_pull; HELP
assistant.ts       the Assistant headless: core assistantAgent with handlers over this server's routes; assistantKit;
                   runAssistantTurn on the engine's one in-memory history
sink.ts            renders a turn's stream parts into Telegram: a waiting bubble, in-place edits, a line per tool call,
                   the final splitFormatted text, then file delivery
bubble.ts          the "..." waiting bubble with exclusive ownership (claim / remove / stop)
entities.ts        markdown → text + entity spans (never parse_mode); clampEntities, truncateFormatted, splitFormatted
client.ts          the Bot API over raw fetch; onSent / onDeleted hooks feed the telegram_sent map
mediaTags.ts       finds files the agent named (MEDIA: tags and bare paths), confines them to the session dir, deliveryKind
attachments.ts     inbound files: classify by magic bytes, write to work/<id>/scratch, compose the note the agent reads
approvals.ts       the approval gate: one ask per chat, inline buttons or the exact word, any other message declines
store.ts           the migration-012 rows: the account row (mode, active session and workspace, webhook secret),
                   telegram_sent, update dedup
deepgram.ts        transcribeVoice and speakVoice, two REST calls, never throws
connect.ts         the outbound connection policy (2 s connect cut, one retry, keep-alive under 5 s); undici's own fetch
alerts.ts          autoBuildAlert: the pure decision for a DM on a loop move
upgrade.ts         UpgradeChecker: periodic GitHub release check, /update command, Approve/Deny inline buttons,
                   triggers POST /update on approval. Callback prefix 'upg' (distinct from 'apv')
sendMessageTool.ts send_message, injected into code-mode turns through extraTools
```

## How a message flows

`handleUpdate` checks the secret header, the enabled setting and the
sender, dedups by update id, acks 200, and runs out of band. `run` first
switches conversation if the message replies to one of the bot's bubbles
(`telegram_sent` says which), then handles a slash command, then resolves
the input (voice note through Deepgram, files into scratch with a note,
or text). A standing approval consumes the exact word and declines on
anything else. A message while a turn runs is queued as one follow-up
turn; the busy key is the active session id in code mode and `assistant`
at home, so a coding turn and an Assistant turn never block each other.
Then the mode picks `assistantTurn` or `codeTurn`.

`codeTurn` opens the session with `lock: true` as client `telegram`,
subscribes the sink to the session feed, and runs `runCodingTurn` with
`send_message` as an extra tool. `assistantTurn` runs the Assistant on
the engine's in-memory history, which resets on restart.

## Two knobs, never written together

Which session (`setActiveSession`) and who answers (`setMode`).
`switchSession` moves the pointer and sends the one 🔀 line.
`enterMode` changes the mode, announces only on a real change, and swaps
the chat's command menu. `/sessions n` and `/new` move the pointer;
`/code` and `/assistant` change the mode; a reply to a bubble does both
as needed. The Assistant's `session_switch` moves the pointer only.

## Files out and in

The agent delivers a file by naming a `/workspace/...` path in its reply,
bare or as `MEDIA:`. The sink strips tags while streaming, then
`collectDeliverables` maps the path to `work/<id>/...`, confines it by
realpath, and sends after the final text. Inbound files land in
`work/<id>/scratch/` and the agent is told the container path.

Offsets in `entities.ts` and `mediaTags.ts` are UTF-16 code units. Never
`Array.from` a string there.

## Reconcile

The webhook URL is always `https://PHANTOM_BACKEND_ADDRESS/telegram/webhook`.
`reconcile` runs at boot and on any `telegram_*` or bot-token write. It
reads `getWebhookInfo` first and re-registers only on drift, keeping the
pending queue. Reactions are spelled as escapes because a pasted glyph
carries a variation selector Telegram rejects.

## Tested in

`test/telegram.test.ts` (entities, attachments, media tags, approvals,
the menus, alerts, upgrade checker, outcome lines). Nothing here runs
against Telegram.
