# The client SDK — where it stands, and what is left

The client SDK (`packages/phantom-client-sdk`) is the one agent runtime for a
phantom-backend. The cli runs on it. The server's card runs (coding agent +
supervisor), cron runs and Telegram still run on `core/llm`, which
duplicates everything the SDK does. This doc is the hand-off for finishing
that.

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

**The SDK.** One base class. A subclass declares `type` and its
`systemPromptLayout` and nothing else; `MyAgent.resumeSession(backend,
handlers, sessionId)` / `MyAgent.newSession(...)`. Inside, one file per job: the connection
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
feed, the rest live; server restart, next request reconnects. It is the
only transport: the server is always https behind Caddy, dev included
(`scripts/setup.sh` runs the `https` profile on Caddy's own CA and saves
the root where the cli trusts it). A non-https URL is refused with a
message; there is no plain-http path.

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
  the turn and the queue rides the next `sendMessage`.
- A stop before anything was sent records nothing and drops the message.
- Session held elsewhere → `sendMessage` rejects `session_locked`, nothing recorded.
- A turn whose answer landed is returned even if turn-ended fails.
- Crash recovery answers exactly the tool calls without a result.
- Another writer's lines are read before the turn; the server's queued user
  messages ride ahead of the user's words.

**The system prompt.** Assembled ONCE when the session is created, written
with the row, never changed; every turn sends it as stored. The agent
declares its layout — three sections (stable, context, volatile), each the
agent's own text and the names of blocks only the server fills (`soul_md`,
`agents_md`, `skills_list`, `secrets_list`, `time_date`, `github_token`,
`agent_database`). `POST /sessions` takes the layout;
`phantom-backend/systemPrompt/SystemPrompt.ts` fills it. One system block
and one cache mark per section. Migration 046 renamed the old two pieces.

**The turn's hold.** turn-start answers plan mode (no row re-read per
turn); a caller that hangs up mid turn-start has its hold released by the
server; a turn that wrote nothing does not count (no model freeze).

**The cli on the SDK (D).** One `PhantomBackend` per window on
`ServerConnection` (`phantom-cli/server.ts`), the window's identity on every
request; errors carry the server's code and status. A coding session is a
`CodingAgent`; the Assistant is an `AssistantAgent` (`follow` on every
switch); the cli's own tools are kits (`cliToolKit`, `assistantToolKit`).
The pane draws from the agent's events; Enter → `sendMessage`, Esc →
`interrupt`, typed mid-turn → queued; a refused send puts the text back.
Quit interrupts every agent and awaits every `close`. Gone: the cli's turn
loop, the local transcript file and its syncs, the nudge queue, local
compaction, the per-turn config/tools fetches, the global fetch override,
and the routes with no caller left (`/backdoor/drain`,
`/agents/:agent/config`, `/agents/:agent/tools`, `/sessions/:id/token-usage`).
`/lock` stays for `core/session.ts` until the server agents move (3).
Proven against the dev stack with a fake OpenAI-compatible model (the
proof scripts live in scratch, not committed).

**The server.** Every tool defined once (`phantom-backend/tools/*`, 35
tools), published per agent type, run through `POST /tools/:name`. Skills
and web logic moved out of the routes into `skills.ts` / `web.ts`. The
record's line count is kept on every write (migration 044). Every record in
the DB is the typed format (migration 045, proven on a real Postgres);
`core/llm` reads and writes that same format so today's hosts keep working.

**Language.** "Looper" no longer means an agent anywhere in code, comments
or screens.

## The conversion, by number

The cli went first: it is the host with everything (a person typing
mid-turn, plan mode flipping live, esc, another window holding the session,
screen tools). It found the SDK's gaps; the headless hosts could not have.

### 1. Leftovers with the cli switch — done

- The key travels only inside turn-start.
- The banner reads provider/model off the session row, reasoning off the
  settings; the turn-start event carries the model after.
- Routes with no caller left are gone: `/backdoor/drain`,
  `/agents/:agent/config`, `/agents/:agent/tools`, `/sessions/:id/token-usage`.
- Left behind: `/lock` and `DELETE /lock` — `core/session.ts` (the server
  agents' old path) still calls them. Go with 3.

### 2. The cli onto the SDK — done

- One `PhantomBackend` per window on `ServerConnection`
  (`phantom-cli/server.ts`); errors carry the server's code and status.
- A coding session is a `CodingAgent`; the Assistant is an
  `AssistantAgent` (`follow` on every switch); the cli's tools are kits.
- Enter → `sendMessage`, Esc → `interrupt`, typed mid-turn → queued, `/pop` →
  `userMessages.take`; a refused send puts the words back; quit awaits
  every `close`.
- Deleted: the cli's turn loop, the local transcript file and syncs, the
  nudge queue, local compaction, the per-turn config/tools fetches, the
  global fetch override, the supervisor read-only rule.
- `partialMessage`: the record keeps what reached the person — voice's
  spoken cut, one rule for every host.
- Left behind:
  - The Assistant's memory across launches lived in the local file; a
    window now opens on an empty assistant session. Bringing it back is
    `resumeSession` on the newest assistant row (one list filter).
  - `/compact` says "not available" (6).
  - No live run in a real terminal with a real model yet — no model key
    on the build box. The store, the Assistant's brain, the transport and
    every turn rule are proven with a fake OpenAI-compatible model; the Ink
    screen itself is not.

### 3. The server's agents onto the SDK (card runs, cron, `/turn`) — next

- The server's turns call its own routes through an in-process shortcut
  (`looper/injectFetch.ts`) that cannot stream, so the SDK's stop-listener
  cannot work through it. The server calls itself over real localhost HTTP
  like any client; the shortcut is deleted. Do this here, not before.
- `looper/turn.ts` (the server's coding-turn runner) goes; the card run
  opens `CodingAgent` / `SupervisorAgent` and adds its card-bound tools with
  `addToolKit()`. Rename the run's `kanban_card_move` — the server publishes
  a tool of that name with a different contract (any card, any column).
- The server's user message queue is written into the record inside
  turn-start; `api/backdoor.ts` goes.
- `core/session.ts` and the `/lock` routes go with the last caller.

### 4. Telegram onto the SDK

### 5. Delete `core/llm`

`PROVIDERS` / `REASONINGS` / token kinds move to where the settings screens
read them. The whole-file transcript routes (`PUT /transcript`,
`/sessions/:id/step`) go with the last whole-file writer. Migration-free.

### 6. Compaction

Server-side, on the record (a `compaction` line the reader honours). Not
discussed yet; the four `*_compact_*` settings are dead until then.

## Decided, not built

- **The system prompt override.** A client may rebuild a session's
  prompt, deliberately, never automatically: `sendMessage(text, {
  rebuildSystemPrompt: true })` → the turn-start body carries
  `system_prompt_layout`; the server, under the hold, assembles from
  today's facts, overwrites the row, answers the new sections in the
  turn-start reply (`system_prompt`, present only when rebuilt); the SDK
  takes them for that turn and after. A record line marks the rebuild. No
  separate route, no separate method.

## How the work went — what to keep doing

- Every change was proven on the real stack before its commit: the dev
  box runs the same https/Caddy stack as an install (`scripts/setup.sh`),
  and a fake OpenAI-compatible model over local HTTP stands in for a key.
  The proof scripts live in scratch, not in the repo (no tests, by
  decision); rebuild them the same way when a rule changes.
- Decisions were named before code: the prompt's three sections and
  their order came from reading Hermes, the cache marks from Anthropic's
  own doc, the cancelled-request release from a pattern already in
  `tools.ts`. When a fact was wrong (the server freezing the prompt, the
  per-turn timezone read) it was said so and fixed, not patched around.
- What was not carried over is listed under its number, with the way
  back. Nothing silent.
- Names were reviewed one by one and written down (below). Keep it that
  way: a name says what the thing is, never "fact", "note", "hint",
  "backend_error".

## Names — decided, do not reinvent

Reviewed name by name with the builder. Keep these; rename only with a reason.

**Objects**: `Agent`, `CodingAgent` / `AssistantAgent` / `SupervisorAgent`,
`PhantomBackend`, `ToolKit`, `SystemPrompt`, `StoredSystemPrompt`
(`{ stable, context, volatile }`), `SERVER_PROMPT_BLOCKS` (the blocks only
the server can fill, each with its reader).

**Methods**
- `Agent.resumeSession(backend, handlers, sessionId)` — an existing session. Was `open`.
- `Agent.create(backend, handlers, …)` — a new session.
- `CodingAgent.newSession(…)` / `AssistantAgent.newSession(…)` — was `start`.
- `Agent.addToolKit(kit)` — was `use`.
- `Agent.sendMessage(text)` — was `send`. `Agent.interrupt()`.
- `Agent.partialMessage(text)` — the person received the last reply only
  up to `text` (a reply cut off while being spoken, after the model had
  written it). The record line is `partial_message`; the reader cuts the
  assistant message before it. A stream cut by `interrupt` needs no call.
- `systemPromptLayout` — the subclass declares its three sections (a static value: it is sent before any agent object exists).
- `agentText(…)` — marks a layout entry as the agent's own text.
- `SystemPrompt.assemble(layout, session)` — fills the layout.
- `SystemPrompt.sections()` — the three strings. Was `write`; it writes nothing.
- `Session.turn(…)`.
- Deleted: per-turn `systemPrompt()`.

**Wire / storage**: `POST /sessions` body `system_prompt_layout`;
`sessions.system_prompt` holds `{ stable, context, volatile }`; turn-start
answers `planMode`.

**Errors**: `PhantomError.code` is the server's code exactly as sent
(`unauthorized`, `session_locked`, `not_found`…) with `status`; the SDK's own
failures are `SDK_ERROR_CODES` (`unreachable`, `bad_response`,
`not_a_stream`, `model_error`, `context_too_long`, `internal`…). There is no
catch-all; `backend_error` is gone.

**Server blocks** (named for what the text is): `soul_md`, `agents_md`,
`skills_list`, `secrets_list`, `time_date`, `github_token`, `agent_database`.
Never "fact", "note", "hint".

**Files**: `phantom-backend/systemPrompt/SystemPrompt.ts`; prompt texts move
`core/llm/prompts/` → `core/prompts/`; `core/agents/clock.ts` deleted.

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
