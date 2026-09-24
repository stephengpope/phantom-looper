# phantom-client-sdk — implementation plan

Where things stand, what the swap-in is, and every detail the agent doing
it needs that the code does not say by itself. The package is the source
of truth for how the SDK behaves; read it before this.

## 1. What exists

`packages/phantom-client-sdk/` — built, 35 tests, lint clean, no consumer
touched. Root `package.json` is an npm workspace (`packages/*`);
`npm run sdk:test | sdk:lint | sdk:build`. Read in this order:

- `README.md` — usage; `src/agent.ts` — the base class, every guarantee;
  `src/turn.ts` — the turn; `src/transcript.ts` — the format and the
  append client; `src/feed.ts` — relay + remote stop; `src/kits/*` — tools;
  `src/agents/*` — the three shipped agents with their prompt text (lifted
  word for word from `core/llm/prompts`).
- `test/fakeBackend.ts` — implements EVERY route the SDK calls, with the
  rules that matter (lock, write-once freeze, append count + delivery id).
  It is the executable contract for the real routes in §3.

### The decisions, in one place (each is enforced by a test)

- Prompt and LLM config are built once at `create`, saved on the row through
  one write-once route, read back on `resume`. Never rebuilt. The date in
  a prompt is the day the session was born. `systemPromptFrozen = false` /
  `llmConfigFrozen = false` on a subclass = resolved every turn, never
  saved. The API key alone is read live (from `GET /agents/:kind/config?session=`,
  `model.apiKey` only).
- Transcript is append-only, pi's line format (`type`, `id`, `at`; messages
  wrapped under `message`). Saved the moment a model call succeeds (user
  messages that rode in, assistant, usage), each tool result as it lands.
  Model failure = nothing saved, queue untouched. Interrupt = finished tools
  keep results, unfinished get `INTERRUPTED_RESULT`, then an `interrupted`
  line. Compaction appends one `compaction` line; loading rebuilds from it.
  No whole-file write exists.
- Append is `{ after, deliveryId, lines }` → server writes only if it has
  exactly `after` lines and has not seen `deliveryId`. Sequential client.
  A save that fails after retries STOPS the turn (`transcript_write_failed`).
- Two queues: nudges (builder's words — start a turn when idle, ride the
  next model call when busy, leftovers start the next turn) and injections
  (system facts — never start a turn, ride the next call, go in ahead of
  the next nudge). Server backdoor facts drain into injections at turn start.
- Tools: `ToolKit { name, mutatingToolNames, version(), build() }`, rebuilt
  only when `version()` moves; `readonly()` asked at execute time, default
  the row's `planMode` (row re-read at turn start), overridable with
  `setReadonly`. Client kits (UI tools) added with `use()`.
- Errors: `onError` and `onNotice` required at construction; every error
  reaches `onError` once with a code from `ERROR_CODES`, then the awaited
  call rejects with it. One background helper. No process-wide handlers in
  the SDK. `context_too_long` is its own code.
- Retries are the client's setting (`handlers.retry`): backend default
  1/2/4/8s under 15s; model default 2…60s under 3 min; 409 never retried;
  the live relay never retries.
- The feed: every turn relays `turn-start`/`part`(150ms batches)/`turn-end`/
  `error` to `POST /sessions/:id/events`; while a turn runs the SDK reads
  `GET /sessions/:id/events` and aborts on `interrupt`. `PhantomBackend.canStream:false`
  skips the read (the server's inject shim buffers whole bodies — a feed
  would never end).
- Billing: the Agent wraps every model handle (turn and compaction) with
  the billing middleware → `POST /log-tokens`. Nothing can call a model
  unbilled, mock models included.
- Cache: first 3 prompt blocks marked, 4th mark rolls on the last message;
  more than 3 blocks on Anthropic = a notice.
- Lock: taken inside `create`'s freeze, inside every turn, inside
  compaction's append; renewed every 60s while held; released after the
  last acknowledged write.

## 2. The swap-in, in order

### Every agent that exists today, and what replaces it

| Today | Where it is built and run | Becomes |
|---|---|---|
| cli coding agent | `phantom-cli/agentFromConfig.ts buildAgent` → `core/llm/agentConfig.ts buildCodingAgent`; run by `phantom-cli/agent.ts runTurn` from `sessions.ts SessionStore.send` | `CodingAgent.create / resume` + `say` |
| cli Assistant (voice pane) | `agentFromConfig.ts buildAssistantAgent` + `assistantKit.ts`; run by `voice.ts VoiceClient.turn` | `AssistantAgent` + cli screen kits via `use()` |
| server coding turn — looper coder | `looper/engine.ts` → `looper/turn.ts runCodingTurn` | `CodingAgent` + `use(loopBlockToolKit(card))` |
| server coding turn — cron run | `crons/engine.ts run` → `runCodingTurn` | `CodingAgent.create` + `say(prompt)` |
| server coding turn — `POST /sessions/:id/turn` | `api/routes/sessions.ts` → `runCodingTurn` | `CodingAgent.resume` + `say`; the ND-JSON reply reads the feed as today |
| server coding turn — git conflict resolver | `index.ts resolveConflict` → `runCodingTurn` | `CodingAgent.resume` + `say(toCodingAgent.resolveConflict(...))` (that message text moves out of `core/llm/prompts/autoPush` to the git module) |
| server coding turn — Telegram code mode | `telegram/engine.ts codeTurn` → `runCodingTurn` | `CodingAgent.resume` + `say`; the bubble reads the feed as today |
| looper supervisor | inline in `looper/engine.ts runTurn` (`new SupervisorAgent`, hand-built kit, `memoryRecorder`) | `SupervisorAgent.create / resume` + `use(loopSupervisorToolKit(card, column))` + `say` |
| Telegram Assistant | `telegram/assistant.ts runAssistantTurn` + `assistantKit` | `AssistantAgent` + the Telegram host kit via `use()` |
| the three agent classes | `core/llm/agents/{coding,supervisor,assistant}.ts` on `createAgent.ts PhantomAgent` | deleted; the package's classes |
| CompactionHelper | `core/llm/compaction.ts` | gone — the Agent compacts |
| TitleHelper, CommitMessageHelper, SessionDigestHelper | `phantom-backend/{sessionTitle,git/commitMessage,notifications/digest}.ts` on `core/llm/helper.ts` | open item §4 — a package `Helper`, or the server keeps the base over the package's `languageModel` |

After the swap there is exactly one way an agent is built and run in the
tree: the package. Nothing else imports `ai` for a chat model.

Each step leaves the system working. Do not start a step before the
previous one's tests pass. Nothing is deleted until nothing imports it.

### Step 1 — server routes (§3), behind the existing ones

Add the new routes and columns without removing anything. The old cli and
the old server turns keep working on the old routes while the new ones
exist beside them. Test each new route against the fake backend's
behavior (`test/fakeBackend.ts` is the spec) — ideally port those cases to
server tests.

### Step 2 — the server's own turns

Replace, one consumer at a time, each verified by its existing behavior:

1. `phantom-backend/looper/turn.ts` `runCodingTurn` + its callers
   (`looper/engine.ts`, `crons/engine.ts`, `api/routes/sessions.ts` turn
   route, `index.ts` conflict turn, `telegram/engine.ts` codeTurn) →
   `CodingAgent.resume(...)` / `create(...)` + `say(text)`. The backend for
   the server is `{ url: 'http://looper/api', apiKey, clientId, fetch: injectFetch(app), canStream: false }`.
   Plan mode: `agent.setReadonly(() => planMode)` for the looper's plan
   column (the row's `planMode` covers the rest). The loop's card tools:
   `agent.use(loopBlockToolKit(card.number))`.
   Remote stop: the interrupt route calls `agent.interrupt()` through the
   `activeTurns` map (keep the map; it maps session → agent now).
2. The supervisor half of `looper/engine.ts` → `SupervisorAgent.create/resume`
   + `use(loopSupervisorToolKit(card.number, column))` + `say(...)`. The
   step rule (`looper/logic.ts`) reads transcripts — it reads the NEW
   format now (`conversationFrom(parseLines(...))`), and `ENDING_TOOLS`
   comes from the package.
3. `telegram/assistant.ts` `runAssistantTurn` → `AssistantAgent`; the
   Telegram host's tools (sessions, workspace create, approvals, docker
   logs) become a client `ToolKit` built from `core/llm/tools/tui.ts` +
   `assistantHandlers.ts` (those two files move to the Telegram/cli side
   or into the package as an `assistantHostToolKit(host)` — decide when
   there; the handlers are already host-abstracted).
4. Seat stamping and naming move server-side: stamp `agent` on the row
   from the relay's `turn-start`; name on `turn-ended`. Delete the
   `stampAgent` / `nameIfUnnamed` calls from looper and crons.
5. Compaction in `looper/engine.ts` (`kickCompaction`) and the Telegram
   assistant (`assistantConversation.ts`) — gone; the Agent does it.

### Step 3 — the cli

1. `phantom-cli/sessions.ts` `SessionStore.send` + `phantom-cli/agent.ts`
   `runTurn` → one `CodingAgent` per open session, held on the entry.
   `say`, `interrupt`, `nudges` replace the store's queue and abort logic;
   `on('part')` feeds `fold()` with the cli's own 150ms batching;
   `on('turn-end')` replaces `onTurnEnd`; the relay (`relay?`), step save
   (`stepSave`), backdoor drain (`drainBackdoor`), lock (`onTurnStart`) and
   the transcript upload chain (`window.ts uploadTranscript`, `syncChains`)
   are all the SDK's now — delete them. The local transcript file
   (`~/.phantom-cli/sessions/*.jsonl`, `session.ts adoptServerCopy`,
   `syncTranscriptUp`, `localSessionIds`) is gone: the server is the record.
   The resume list's "last user message" comes from the server row.
2. `sessionFeed.ts`: keep for WATCHING other clients' turns; drop its
   `interrupt` case for our own turn (the SDK hears it) — or keep it as a
   second source calling `agent.interrupt()`, harmless.
3. `voice.ts` `VoiceClient.turn` → `AssistantAgent` + `say(text)` /
   `say(pendingTranscription)` (a pending nudge — `next()`/speak-over
   semantics are gone: speaking over = `interrupt()` then the queue runs).
   `window.ts rebuildAssistant` → `agent.follow(activeId, workspaceId)` on
   a switch; the assistant's session is created with `AssistantAgent.create`.
   The cli's screen tools (`kanban_screen`, `session_*` list/switch/close,
   `session_set_mode`, `workspace_create_repo`, `docker_logs`, the approval
   pane) become client `ToolKit`s added with `use()`.
4. `window.ts` `/compact` → `agent.compact()`; `/plan` → `setReadonly`;
   `/pop` → `agent.nudges.pop()`; model-moved notes → `onNotice`.
5. `agentFromConfig.ts`, `assistantKit.ts`, `agent.ts` (cli) — deleted.
6. `index.tsx`: `setTokenRecorder` gone; the SDK bills. The crash handlers
   stay (the application owns them).

### Step 4 — delete what nothing imports

`core/llm/createAgent.ts`, `agents/*`, `agentConfig.ts`, `compaction.ts`,
`nudgeQueue.ts`, `transcript.ts`, `tools/*`, `prompts/*` (the SDK carries
the text), `core/session.ts`. Keep `core/llm/helper.ts` ONLY if the one-shot
helpers (title, commit message, digest) are not moved — see §4.
`phantom-backend/agentConfig.ts` stays (the settings cascade is the
server's; the route serves it). Old routes: `PUT /sessions/:id/transcript`,
`POST /sessions/:id/step`.

### Step 5 — Dockerfile and CI

`COPY packages/ packages/` before `npm ci` in `Dockerfile` (the server
imports the package now). `.github/workflows/release.yml` runs `npm ci` at
root — workspaces install with it; add `npm run sdk:test` and `sdk:lint`
to the checks.

## 3. Server routes — the exact contracts

`test/fakeBackend.ts` is the reference implementation of all of these.

| Route | Change |
|---|---|
| `POST /sessions { workspace_id, id? }` | Creates a bare row. No prompt built. `id` restarts a swept session (as today). |
| `POST /sessions/assistant { workspace_id, session_id? }` | As today, no prompt. |
| `POST /sessions/supervisor { workspace_id, folder_id, card_id }` | NEW. Today the looper inserts the row directly (`Sessions.createSupervisor`); route it. |
| `PUT /sessions/:id/frozen { systemPrompt?: string[], llmConfig? }` | NEW, write-once per field; 409 `prompt_frozen` if set. Requires the lock. |
| `GET /sessions/:id` | Answers `system_prompt: string[] \| null`, `llm_config`, `planMode`, `folderId`. Drop the "freeze if missing" fallback (line ~756 today). |
| `GET /sessions/:id/transcript` | `{ data: string \| null, lines: number }`. Old-format files converted on read (§5). |
| `POST /sessions/:id/transcript/append { after, deliveryId, lines }` | NEW. One statement: `UPDATE sessions SET transcript = transcript \|\| $lines, transcript_lines = transcript_lines + $n, last_delivery_id = $k WHERE id=$1 AND locked_by=$client AND transcript_lines=$after AND last_delivery_id IS DISTINCT FROM $k`. 0 rows → if `last_delivery_id = $k` answer `{ lines, applied:false }`, else 409 `transcript_conflict` (count) or 409 `session_locked`. Answer `{ lines, applied }`. Renew the lock. Derive `last_user_message` and the naming context from the appended lines. Publish `transcript` on the feed. |
| `POST /sessions/:id/turn-ended` | Every session, not only the assistant: turn count +1, `last_used_at`, model pin if turn count left 0 (or drop the pin — `llm_config` IS the pin now), naming when due. Requires the lock. |
| `POST /sessions/:id/events { events }` | As today. Stamp the row's `agent` from `turn-start.agent`. |
| `GET /sessions/:id/events` | As today. |
| lock / ping / backdoor drain / follow / `GET /agents/:kind/config` / `POST /log-tokens` | As today. |
| `POST /sessions/:id/duplicate` | Copies transcript (usage lines stripped, as today) + `system_prompt`; `llm_config` resolved fresh. |
| `PUT /sessions/:id/transcript`, `POST /sessions/:id/step` | Removed in Step 4. |

Schema: `sessions.transcript_lines int not null default 0`,
`sessions.last_delivery_id text`, `sessions.llm_config jsonb`;
`system_prompt` (jsonb) holds `string[]`. Migration `042_sdk_transcript.sql`:
add the columns; backfill `transcript_lines` = line count of the converted
transcript (or convert lazily on first read and set the count then — the
read route can do it under the lock). `provider/model/base_url` pin columns
become redundant with `llm_config` — leave them until Step 4, then drop.

## 4. Open items — decide during the swap-in, not before

- **One-shot helpers** (`TitleHelper`, `CommitMessageHelper`,
  `SessionDigestHelper` in `phantom-backend`, on `core/llm/helper.ts`). They
  need a model handle + billing, not an agent. Options: (a) the package
  exports `languageModel` + `billingMiddleware` and the server keeps a
  tiny helper base; (b) the package ships `Helper` (kind, one `call`).
  (b) keeps "nothing calls a model outside the package."
- **Settings cascade** stays on the server (`phantom-backend/agentConfig.ts`);
  the SDK never reads a setting by name. `AGENT_KINDS` / `kindOf` (the
  class-name → billing-kind rule in `createAgent.ts`) — the SDK uses the
  subclass's declared `kind` instead; the token report groups by it.
- **Assistant host tools** (`tui.ts` + `assistantHandlers.ts`): package or
  client? They are host-abstracted already; if both hosts keep them
  identical, package (`assistantHostToolKit(host: AssistantHost)`).
- **Old transcripts**: convert on read (one function, both shapes in, new
  shape out), never a bulk migration. The `{type:'session'}` header,
  bare `{role}` lines, `{type:'usage'}` lines, `{summary:true}` user
  messages (old compaction) → a `compaction` line? Simplest: an old
  summary message stays a plain user message; nothing before it exists in
  the file anyway (old compaction rewrote).
- **Voice "speak over"**: today a new utterance replaces the running turn.
  With the SDK: `interrupt()` then `say()` — the queue starts it. Confirm
  that is the wanted feel.
- **Telegram `/stop`**: `agent.interrupt()` on the Telegram engine's agent
  (server-side, `canStream:false`).
- **`GET /keys/:provider`**: optional; today the key rides
  `GET /agents/:kind/config?session=`.
- **`Dockerfile` order**: `COPY packages/` must precede `npm ci`.

## 5. Things learned building it (so nobody re-learns them)

- `ToolLoopAgent` fixes tools at construction; `prepareStep` can only
  narrow `activeTools`. Per-turn tools → `streamText` per turn.
- `onLanguageModelCallEnd` fires after the model's response is parsed and
  BEFORE tool execution, with content parts that carry reasoning and its
  provider signature — the only clean "model call succeeded" hook.
  `messages.ts` mirrors the AI SDK's own `toResponseMessages`.
- The AI SDK swallows anything a callback throws (`util/notify.ts`
  `catch {}`). Callbacks must never throw; the runner records the failure,
  aborts, and rethrows after the stream closes.
- `streamText` refuses an empty `messages` list: the first call's pending
  text must be in the initial messages, not only in `prepareStep`.
- A tool result can arrive before the assistant message is recorded (tools
  are dispatched as their calls stream); the runner holds such results
  until the assistant line is written, so the record is always in order.
- Anthropic's converter merges consecutive tool messages into one block:
  one tool message per result is safe.
- pi (`earendil-works/pi`, `packages/agent/src/agent-loop.ts`) answers an
  aborted tool call with an error result "Operation aborted" — the
  precedent for `INTERRUPTED_RESULT`. pi's session format
  (`session-manager.ts`) is the precedent for the line format and for
  compaction-as-a-line (`firstKeptEntryId`).
- Text queued before the first model call is built rides that call, not a
  second turn (there is a window between `say()` and the drain).
- The server's `injectFetch` cannot stream; anything that reads a feed
  must be optional on the transport (`canStream`).
