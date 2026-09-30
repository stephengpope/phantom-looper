# The client SDK — where it stands, and what is left

The client SDK (`packages/phantom-client-sdk`) is the one agent runtime for a
phantom-backend. It is built and on main. No host runs on it yet: the cli,
the server's card runs (coding agent + supervisor), cron runs and Telegram
still run on `core/llm`, which duplicates everything the SDK does. This doc
is the hand-off for finishing that.

## Words

- **Looper** — the thing that watches the board and starts agents. Not an agent.
- **Card run** — one card being planned or built: a coding agent and a
  supervisor working under one lock identity.
- **Type** — which agent a session runs (`coding`, `supervisor`, `assistant`).
  Never "kind".
- **The record** — the session's transcript on the server. One format
  (typed lines). No local copy anywhere.
- **The server's user message queue** — one-liners the server holds for a
  session's next turn (a detached command exited, a sync pulled). Not "notes".

## Done

**The SDK.** One base class. A subclass declares `type` and `systemPrompt()`
and nothing else; `MyAgent.open(backend, handlers, sessionId)` /
`MyAgent.create(...)`. Inside, one file per job: the connection
(`serverConnection.ts`, `backend.ts`), the session — row, record, turn
(`session.ts`, `record.ts`), the model (`model/`), the turn (`turn.ts`),
the feed (`feed.ts`). The record's line format is on its own subpath
(`phantom-client-sdk/transcript`) for the server. Public surface: `Agent`,
`PhantomBackend`, `ServerConnection`, `PhantomError`, the events, `ToolKit`,
`billedModel`, types.

**One connection.** `ServerConnection`: one HTTP/2 socket carries every
call, feed and turn; reconnects on drop. The cli installs it as the fetch
for the server's origin, so every caller — cli, core tools, git streams —
rides it unchanged. Proven: 3 feeds + 20 requests on one socket; abort one
feed, the rest live; server restart, next request reconnects. A plain-http
dev server (no Caddy, no HTTP/2) keeps the platform fetch.

**One request per turn start.** `POST /sessions/:id/turn-start` holds the
session, writes the server's queued user messages into the record, answers
the model config (with key) and the tool list. The SDK's turn is
turn-start → run → turn-ended; turn-ended releases the hold, always, crash
included. Before: five sequential requests.

**The turn rule, proven by a harness (32 checks, fake server + fake model):**
- A user message starts a turn. Text sent while a turn runs is queued; it
  rides the next model call, or continues the turn when the model stops.
- `interrupt()` cuts the model loop; what was queued continues the **same
  turn** — same hold, one turn-ended. `interrupt({ keepQueue: true })` ends
  the turn and the queue rides the next `send`.
- A stop before anything was sent records nothing and drops the message.
- Session held elsewhere → `send` rejects `session_locked`, nothing recorded.
- A turn whose answer landed is returned even if turn-ended fails.
- Crash recovery answers exactly the tool calls without a result.
- Another writer's lines are read before the turn; the server's queued user
  messages ride ahead of the user's words.

**The cli, today's path.** Enter shows the spinner immediately; a refused
send puts the text back in the box (or the session's draft off-screen).

**The server.** Every tool defined once (`phantom-backend/tools/*`, 35
tools), published per agent type, run through `POST /tools/:name`. Skills
and web logic moved out of the routes into `skills.ts` / `web.ts`. The
record's line count is kept on every write (migration 044). Every record in
the DB is the typed format (migration 045, proven on a real Postgres);
`core/llm` reads and writes that same format so today's hosts keep working.

**Language.** "Looper" no longer means an agent anywhere in code, comments
or screens.

## Not done — the conversion, in order

The cli goes first: it is the host with everything (a person typing
mid-turn, plan mode flipping live, esc, another window holding the session,
screen tools, one-shot title calls). If the SDK's shape is wrong anywhere,
the cli finds it; the headless hosts can't.

### 1. Leftovers that land with the cli switch

- The old cli still takes the lock and reads the config through the old
  routes — it needs the key to build its own agent. `/lock`, `DELETE /lock`,
  `/agents/:type/config`, `/agents/:type/tools`, `/backdoor/drain` go when
  the last host stops using them. After that the key travels only inside
  turn-start, and the banner reads provider/model off the session row.

### 2. The cli onto the SDK

- Coding sessions: `CodingAgent.open/start` from `core/agents`. Esc =
  `agent.interrupt()`.
- Delete: the local transcript file (`~/.phantom-cli/sessions/`),
  `adoptServerCopy`, `syncTranscriptUp`, `stepSaveUp`, the nudge queue, the
  cli's compaction calls. Every step is on the server as it lands; a local
  copy is a second truth.
- The cli's own tools become `use()` kits: sessions list/read/switch,
  docker logs, workspace create, screen mode, the code-mode ask (blocks a
  tool call on a dialog; the SDK passes the abort signal through, so it
  works unchanged), the board with repaint, git push/pull with progress.
- The assistant (`voice.ts`) becomes `AssistantAgent.open()` + its kit;
  `follow` on session switch.
- Plan mode: the cli PATCHes the row; the SDK reads it at turn start and
  off the feed mid-turn. The cli's mirror is display-only.
- Token totals: `session.usage` from the record replaces the cli's live
  estimate + `GET /token-usage`.

### 3. The server's agents onto the SDK (card runs, cron, `/turn`)

- The server's turns call its own routes through an in-process shortcut
  (`looper/injectFetch.ts`) that cannot stream, so the SDK's stop-listener
  cannot work through it. The server calls itself over real localhost HTTP
  like any client; the shortcut is deleted. Do this here, not before.
- `looper/turn.ts` (the server's coding-turn runner) goes; the card run
  opens `CodingAgent` / `SupervisorAgent` and adds its card-bound tools with
  `use()`. Rename the run's `kanban_card_move` — the server publishes a tool
  of that name with a different contract (any card, any column).
- The server's user message queue is written into the record inside
  turn-start; `api/backdoor.ts` goes.

### 4. Telegram onto the SDK.

### 5. Delete `core/llm`

`PROVIDERS` / `REASONINGS` / token kinds move to where the settings screens
read them. The whole-file transcript routes (`PUT /transcript`,
`/sessions/:id/step`) go with the last whole-file writer. Migration-free.

### 6. Compaction

Server-side, on the record (a `compaction` line the reader honours). Not
discussed yet; the four `*_compact_*` settings are dead until then.

## Notes worth keeping

- The AI SDK throws the abort reason out of the stream on a stop; there is
  no `abort` part. The turn absorbs that and records the cut step
  (`turn.ts`). Found by the harness, not by reading.
- A plan-mode flip is published to every feed reader, the flipping window
  included — the feed drops a client's own events otherwise, and the
  running turn in that window must hear it.
- The Anthropic subscription-token headers, the one model that cannot turn
  thinking off, and the 1 h cache TTL are provider quirks kept in
  `model/languageModel.ts` and `model/cache.ts`, named in code.
- `sessions.agent` in the DB means "who drove the last turn", not "which
  agent". Comment says so; the column is not renamed.
- The proof harness is not committed (no tests, by decision). It lived in
  `scratch-tmp/proof.mts`: a fake backend via injected fetch and a fake
  OpenAI-compatible model over local HTTP. Rebuild it the same way when a
  turn rule changes.
