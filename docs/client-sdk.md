# phantom-client-sdk — the plan

The one way an agent is built and run against a phantom-backend. Written fresh,
in its own package. The cli, the server (looper, crons, the turn route, git
conflict turns) and the Telegram bot become consumers of it. Nothing in this
document describes today's code except where a server route must change.

Every decision below was discussed and settled. Nothing here is open.

---

## 1. The package

- Path: `packages/phantom-client-sdk/`, own `package.json` (`name`,
  `version`, `exports`, `main`, `types`).
- Root `package.json` gains `"workspaces": ["packages/*"]`. Consumers import
  it by name. Same `tsc` build.
- Publishing later is `npm publish` in that folder — one command, nothing
  else changes. No npm work now.
- ESLint in the package with `@typescript-eslint/no-floating-promises` and
  `no-empty` as errors. A later edit that drops a promise or writes an empty
  `catch` fails the build.
- Tests in the package, run against a fake backend. Built and tested before
  any consumer is touched.
- Depends on `ai` (AI SDK, currently 7.0.73) and the provider packages.
  Uses `streamText` per turn — NOT `ToolLoopAgent` (verified: it fixes tools
  at construction; `prepareStep` cannot hand in a new tool set).

---

## 2. The object

One base class, `Agent`. A subclass per kind: `CodingAgent`,
`SupervisorAgent`, `AssistantAgent`, and any new one.

### A subclass declares

| Member | Meaning |
|---|---|
| `kind` | The billing kind (`coding`, `supervisor`, `assistant`, …) |
| `systemPrompt()` | Builds the prompt: a list of text blocks |
| `toolKits()` | Its default tool kits |
| `systemPromptFrozen = true` | May be set `false` — see §3 |
| `llmConfigFrozen = true` | May be set `false` — see §4 |
| `compactionStrategy` | Which summarizer; default `fast` |

The base class adds NO prompt text. Values, stakeholders, communication style
and every other block live in the subclass. Prompt text is a product concern.

### The base class owns

create / resume · system prompt freezing · llm config freezing · tool kits ·
the turn · nudges and injections · interrupt · the transcript · token billing
· compaction · errors and notices · events.

### Public surface

```
static create(backend, { kind-specific opts })   → Agent   (new session row)
static resume(backend, { sessionId })            → Agent   (existing row)

sessionId, workspaceId
messages        the live conversation (what the next model call is built from)
usage           lifetime token totals
busy            a turn is running

say(text)                   builder text — see §7
inject(text)                system fact — see §7
interrupt()                 stop the running turn
compact()                   summarize old history now (also automatic, §9)
setReadonly(fn)             live: plan mode
use(toolKit)                add a client-defined kit
on(event, fn)               subscribe — see §10
close()                     release everything
```

### Construction requires

- `backend`: `PhantomBackend` — `{ url, apiKey, clientId, fetch? }`. Local or
  remote is only the `fetch` (the server passes its in-process shim).
- `onError(error)`: required. Cannot construct without it. See §10.
- `onNotice(notice)`: required. See §10.

---

## 3. The system prompt — frozen

- `systemPrompt()` returns `string[]`: any number of blocks.
- `systemPromptFrozen = true` (default): `create()` runs `systemPrompt()`
  ONCE and saves the blocks on the session row through the write-once route
  (§12). `resume()` reads them back. Every turn sends them verbatim. Nothing
  is ever appended, re-dated or rebuilt. The date, if a subclass wants one,
  is a block written at creation — it is the date the session was born.
- `systemPromptFrozen = false`: `systemPrompt()` runs at the start of every
  turn; nothing is saved on the row.
- Cache marks: the first 3 blocks each get an Anthropic cache breakpoint; the
  4th mark is the rolling one on the last conversation message (Anthropic
  allows 4). More than 3 blocks on an Anthropic model → one `onNotice`,
  never an error. Other providers ignore the marks.
- What the coding prompt needs — skills, secrets, settings, SOUL.md,
  AGENTS.md — the subclass fetches over the API inside `systemPrompt()`:
  `GET /skills`, `GET /secrets?workspace=`, `GET /settings`, and the `read`
  tool for the two repo files. The server no longer builds prompts.

---

## 4. The LLM config — frozen

`llmConfig` = `{ provider, model, endpoint, reasoning, maxSteps, compaction }`.

- `llmConfigFrozen = true` (default): `create()` resolves it once from
  `GET /agents/:kind/config?workspace=` and saves it on the row in the same
  write-once call as the prompt. `resume()` reads it back. Never re-read.
- `llmConfigFrozen = false`: resolved from that route at the start of every
  turn; never saved.
- The API key is the one thing always read live (keys rotate). It is looked
  up by the frozen provider.
- To run the same conversation on a different model: `POST /sessions/:id/duplicate`
  — copies the transcript and the prompt; the new row resolves its own config.
- The model handle is built from the config and memoized; with a frozen
  config it is built once per agent.

---

## 5. Tool kits

- A `ToolKit` is `{ name, mutatingToolNames, version(), build(ctx) }`.
  `build` returns AI SDK tools. `version()` is cheap; the SDK rebuilds a
  kit's tools only when its version changes (e.g. the workspace kit's version
  includes the session's folder id, so a folder switch rebuilds it).
- `ctx` = `{ backend, sessionId, workspaceId, readonly: () => boolean }`.
  `readonly` is asked at EXECUTE time, never at build. A mutating tool called
  while `readonly()` is true returns `{ ok:false, error:{ code:'readonly' } }`
  to the model. Server-side callers pass a constant; the cli passes its plan
  mode flag. One mechanism.
- Default kits shipped in the package: `workspaceToolKit` (bash read write
  edit ls find grep task_*; definitions fetched from `GET /tools` once per
  agent), `webToolKit`, `skillsToolKit`, `secretsToolKit`, `cronsToolKit`,
  `databaseToolKit`, `kanbanToolKit` (API-backed, the only kanban kit),
  `notifyToolKit`, `gitToolKit`.
- Client kits: the cli's screen tools (open the board, open a card, switch
  what's on screen) are UI-only, defined in the cli, added with `use()`,
  same interface. They never replace a package kit.
- Tools bound to a context (the loop's `kanban_card_block`,
  `kanban_card_move`, `kanban_card_items`, bound to one card) are kits the
  consumer builds and adds with `use()`.
- A tool failure is returned to the model as its result (it self-corrects)
  AND emitted as a `tool-error` event. Never only one.

---

## 6. The turn

`say(text)` when no turn is running starts one. A turn:

1. Take the session lock (`POST /sessions/:id/lock`). Held by another →
   error `session_locked`. Renew it on a timer (`POST /sessions/:id/ping`)
   while the turn runs, so a long tool never outlives it.
2. Drain the server's pending injections (`POST /sessions/:id/backdoor/drain`)
   into the injection queue.
3. If `llmConfigFrozen`/`systemPromptFrozen` are false, resolve them now.
4. Resolve tools (rebuild only kits whose version moved).
5. Append the user message(s) — see §8 for exactly when.
6. `streamText` with `stopWhen` = maxSteps (null = unlimited), `maxRetries: 0`
   (retries are the SDK's own fetch wrapper, never the AI SDK's), and:
   - `prepareStep`: re-place the cache marks; drain ready nudges and
     injections into this call's messages (§7).
   - `onLanguageModelCallEnd`: the model call succeeded → build the
     assistant message from its content parts (reasoning with provider
     signatures included — verified this hook carries them) → append it and
     the usage line NOW, before tools run.
   - each `tool-result` / `tool-error` part → append that result as it lands.
   - every part → `part` event, unbatched (batching is the client's).
7. Model call fails: nothing from that step is appended; nudges/injections
   drained into it go back to the front of their queues; the error goes to
   `onError` and the turn rejects with it.
8. Interrupt (`interrupt()` or the abort signal): the partial assistant text
   and every tool call are kept; each finished tool keeps its result; each
   unfinished one gets an error result `interrupted — check before repeating`
   (pi's rule: "Operation aborted"); an `interrupted` line is appended. The
   SDK does not wait for a tool that ignores the abort signal. The turn
   resolves with outcome `interrupted`.
9. `POST /sessions/:id/turn-ended`.
10. Release the lock after the last append is acknowledged.
11. Compaction check (§9).
12. Anything still in the nudge queue → the next turn starts (§7).

Returns `{ text, messages, usage, outcome: 'done' | 'interrupted' }`.
`say()` while busy does not start a turn (it queues, §7). `turn` is never
queued by the SDK — only nudges are.

Concurrency: `turn()` waits for a running compaction to finish before it
starts. Compaction waits for a running turn.

---

## 7. Nudges and injections — two queues

Both are user-role messages when they reach the model, each marked with its
source. They differ in what they trigger.

| | Nudge — `say(text)` | Injection — `inject(text)` |
|---|---|---|
| What it is | The builder's own words (typed, spoken, Telegram) | A system fact: a background command exited, a file was dropped, files were pulled, a conflict needs resolving |
| No turn running | Starts a turn | Waits; goes in ahead of the next nudge that starts one |
| Turn running | Rides the very next model call | Rides the very next model call |
| Still queued when the turn ends | Starts the next turn, all of them together | Waits for the next nudge |

- A pending nudge (voice still transcribing) holds the queue behind it; it
  is drained once it settles. A failed transcription is removed and reported
  through `onError`.
- Drained into a model call that then fails → put back at the front.
- Saved with the step they rode, after that step's model call succeeded.
- `interrupt()` stops the current turn; the nudge queue then starts the
  next one if it has anything. No other interrupt semantics exist.
- Server-queued injections (today's backdoor queue) are drained at turn
  start into the injection queue.

---

## 8. The transcript — append-only

### Format (pi's session format; every line is JSON, one per line)

```
{ type:"message",     id, at, message:{ role, content } }
{ type:"usage",       id, at, provider, model, input, output, cacheRead, cacheWrite }
{ type:"interrupted", id, at }
{ type:"compaction",  id, at, summary, firstKeptId }
```

- `id`: unique per line. `at`: ISO timestamp.
- A `message` line is exactly the AI SDK message that went to (or came from)
  the model. `providerOptions` (cache marks) are per-call and are NEVER
  written; the append refuses a message that carries them.
- No header line. Everything about the session lives on its row.
- Loading: take the last `compaction` line if any → its `summary` becomes the
  first message, then every `message` line after `firstKeptId`. Without one,
  every `message` line. Older lines stay as history and are never sent to
  the model again.
- The server converts old-format transcripts (bare `{role,…}` lines, bare
  `{type:'usage'}` lines, `session` headers) once, on read.

### When a line is appended

| Moment | Lines |
|---|---|
| Turn start | the user message(s): injections first, then the nudge(s) — appended together with the first step, AFTER that step's model call succeeds |
| Model call succeeded | the assistant message, then its `usage` line |
| Each tool finished | its tool-result message (one message per result, in completion order) |
| Interrupt | the partial assistant message if not yet written, results for finished tools, `interrupted` results for unfinished ones, then an `interrupted` line |
| Compaction done | one `compaction` line |

Nothing is appended for a model call that failed.

### The append call — and why it cannot lose or double a line

`POST /sessions/:id/transcript/append { after: n, deliveryId: k, lines: [...] }`

The SDK says: "you have n lines; here are the next ones; this is delivery k."
The server, in ONE atomic statement, writes only if it has exactly n lines
AND has not already applied delivery k. It answers with the line count it
now has and whether k was applied.

- Reply lost → SDK resends k → server already has k → answers, writes
  nothing. No duplicate.
- Request lost → server still has n → writes. No loss.
- Server died mid-write → the statement is all-or-nothing → the resend lands
  in one of the two cases above.
- Someone else wrote → count ≠ n → refused with `transcript_conflict`.
  Cannot happen under the lock; the same statement checks the lock.

The SDK never sends delivery k+1 before k is answered, so the count it holds
always equals the server's after every answer. One number, checked every
time.

**The hard rule:** an append that fails after the retry schedule STOPS THE
TURN with error `transcript_write_failed`. Nothing runs unrecorded. There is
no local copy and no "kept locally" rescue. The server is the record.

### Server side

- Column `transcript_lines` (int) on `sessions`, and the last applied
  `deliveryId`. Append is one `UPDATE … WHERE id=$1 AND locked_by=$client AND
  transcript_lines=$n AND last_delivery_id IS DISTINCT FROM $k`.
- The handler reads the appended lines for what the whole-file PUT used to
  derive (last user message, naming context).
- `GET /sessions/:id/transcript` returns the lines (and the count).

---

## 9. Compaction

- Runs automatically after every turn when the frozen `llmConfig.compaction`
  thresholds say so; `compact()` runs it on demand. Every agent, same code.
- Runs in the background through the SDK's one background helper (§10), so
  a failure reaches `onError`.
- The summary is written by the model named in the compaction config (the
  supervisor's slot, today's rule — a settings matter, not the SDK's).
- Result: one `compaction` line appended; the in-memory `messages` replaced
  with summary + kept tail. No file rewrite.
- `turn()` waits for a running compaction; compaction waits for a running
  turn.

---

## 10. Errors, notices, events

Two required functions and one subscription.

**`onError(error)`** — every error the SDK produces reaches it, once, with
its code and stack. Inside the SDK:
- No `catch` that does nothing. Every `catch` hands the error to `onError`
  or rethrows. The linter enforces it.
- Exactly one way to start background work (a single helper); it awaits the
  work and routes any failure to `onError`. Nothing is started any other way.
- Calls the client awaited (`create`, `resume`, `say` when it starts a turn,
  `compact`, `close`) ALSO reject with the same error — after `onError` has
  it. So an error is in the log even if the caller forgot to handle it.
- The SDK installs NO process-wide handlers (`uncaughtException`,
  `unhandledRejection`). Those belong to the application, one per process.
  A library that installs them is a bug.

**`onNotice(notice)`** — non-error information: a retry ("model answered
429 — retry 2/7 in 4s"), more than 3 prompt blocks on Anthropic, compaction
ran. The server logs every one; the cli shows every one. Not optional.

**`ErrorCode`** — one exported list. Every error carries one:
`session_locked`, `session_not_found`, `transcript_conflict`,
`transcript_write_failed`, `model_error`, `no_api_key`, `tool_build_failed`,
`readonly`, `busy`, `prompt_frozen` (a write to the prompt after freeze),
`config_invalid`, `compaction_failed`.

**Events** (`on(event, fn)`, optional to listen):
`turn-start` · `part` (every stream part, unbatched) · `step` (appended and
acknowledged) · `nudge` (what rode into a call) · `tool-error` · `turn-end`
· `compacted`.

One failure, one handler call. Never duplicated across channels.

---

## 11. Model layer (inside the package)

- Providers: anthropic, openai, openai-codex, google, deepseek, kimi, xai,
  mistral, groq, openai-compatible. Anthropic subscription-token handling
  (Bearer, Claude Code headers, identity block first). Reasoning mapping
  ('none' → 'minimal' on models that cannot stop thinking).
- Retries: the SDK's own fetch wrapper, schedule 2/4/8/15/30/45/60s, 180s
  budget, retry-after honored, each attempt reported via `onNotice`.
  Every AI SDK call sets `maxRetries: 0`.
- Cache marks: first 3 prompt blocks + the last conversation message,
  re-placed on copies before every step. TTL 1h.
- Token billing: every model call → `POST /log-tokens` with kind, session,
  provider, model, tokens. Always over the API — the server, as a consumer,
  goes through its own route like everyone else.

---

## 12. Server changes required (the swap-in phase, not now)

1. `POST /sessions` no longer builds a prompt; creates a bare row.
   `POST /sessions/assistant` and the supervisor's creator likewise.
2. New `PUT /sessions/:id/frozen { systemPrompt: string[], llmConfig }` —
   write-once; 409 `prompt_frozen` if already set. Requires the lock.
3. New `POST /sessions/:id/transcript/append` — §8. Requires the lock.
4. `POST /sessions/:id/turn-ended` generalized to every session (turn count,
   last used, naming). Requires the lock.
5. `PUT /sessions/:id/transcript` (whole file) and `POST /sessions/:id/step`
   removed once no consumer uses them.
6. `GET /sessions/:id` drops its "freeze if missing" fallback.
7. `POST /sessions/:id/duplicate` copies transcript + prompt, resolves a
   fresh llmConfig.
8. `sessions` gains `transcript_lines`, `last_delivery_id`, `llm_config`;
   `system_prompt` holds `string[]`.
9. Old transcripts converted on read.
10. The server process registers Node's `uncaughtException` /
    `unhandledRejection` handlers: log, exit; docker restarts. (The cli has
    them already.)
11. Session lock rules unchanged; every write route above checks it.

---

## 13. What consumers keep

Only what is theirs: the cli's screens, its 150ms repaint batching, the
board store; the looper's card logic, seats and budget; Telegram's bubbles
and commands; crons' schedule. None of them build tools, run turns, count
tokens, save transcripts, or handle nudges.

---

## 14. Names

| | |
|---|---|
| Package | `phantom-client-sdk` |
| Base class | `Agent` |
| Subclasses | `CodingAgent`, `SupervisorAgent`, `AssistantAgent` |
| Backend connection | `PhantomBackend` |
| Prompt | `systemPrompt`, `systemPromptFrozen` |
| Model settings | `llmConfig`, `llmConfigFrozen` |
| Tools | `ToolKit`, `*ToolKit` |
| Conversation | `Transcript`, `TranscriptLine` |
| Queues | `nudges`, `injections` |
| Actions | `say`, `inject`, `interrupt`, `compact`, `close` |
| Handlers | `onError`, `onNotice` |
| Codes | `ErrorCode` |
| One model call + its tool calls | step |
| One `say` through to its reply | turn |
