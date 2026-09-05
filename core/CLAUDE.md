# core/ — shared by the app and the service

Imports from neither side: `/phantom-cli` and `/phantom-backend` both import
`/core`; nothing here may import from either. Everything an agent IS (its
prompt, its model, its retries, its transcript) and every headless tool kit
lives here, so the cli and the looper build the same agent from the same
parts.

```
ids.ts                newId() lowercased ULID · idTime(id) decodes its mint time (the pool ages slots by name)
kanban.ts             DEFAULT_COLUMNS (backlog plan in_progress blocked done — the one source for routes AND tool enums) ·
                      requirement keys: newKey() 4 chars [a-z0-9], server-assigned, frozen for the item's life;
                      normalizeKey lowercases a model's echo; keyedItems keeps caller keys, re-ids duplicates
session.ts            openSession — THE session path (below) · SessionLockedError · ApiCall
skills/skills.ts      scanner: SKILLS_DIR '.agents/skills', scanSkills, mergeSkills, frontmatter parsing
skills/validate.ts    write-side rules: name regex, SKILL.md, file paths, size limits, lintSkillMd (advisory)
llm/createAgent.ts    provider switch · OAuth disguise · thinking rule · withRetry · withCacheBreakpoints · createAgent
llm/agentConfig.ts    settings → ModelConfig: PROVIDER_KEY, cascade, agentModelConfig, modelConfigFrom, buildCodingAgent
llm/transcript.ts     the ONE transcript format: Transcript (file-backed), parse/serialize, usage events, memoryRecorder
llm/agents/           coding · assistant · gitFixer · supervisor — one file each: instructions + agent builder
llm/prompts/          template.ts (fill) · shared blocks (stakeholders values communication environment git sending) ·
                      <name>/<name>.ts the DOCUMENT + wiring.ts the code that fills it — one folder per agent,
                      plus helpers/ (one-shot helpers, no agent: sessionTitle.ts + wiring.ts)
llm/tools/            presets.ts (pickKit) · workspace skills web secrets kanban tui server
```

## Agents (llm/agents/)

| agent | builder | prompt | maxSteps | reasoning | date | kit |
|---|---|---|---|---|---|---|
| coding | `codingAgent(model, tools, {maxSteps, instructions})` | `codingInstructions(skills, git, secrets, environment)` | setting `max_steps`, null = unlimited | setting | appended | caller's |
| Assistant | `assistantAgent(model, tools)` | `assistantInstructions()` | 10 | pinned `'none'` | appended | caller's |
| supervisor | `supervisorAgent(model, tools)` | `supervisorInstructions()` | 12 | inherited | appended | caller's |
| Git Fixer | `gitFixerAgent(model, exec, branch, sessionId)` | `gitFixerInstructions(branch, sessionId)` | 40 | inherited | NONE | builds its own: `fixerBashTool(exec)` |

- Only the Git Fixer declares its kit. The other three take `tools` from
  the call site: `phantom-backend/looper/turn.ts` (coding, server-side —
  the looper, the turn route, Telegram code mode),
  `phantom-backend/looper/engine.ts` (supervisor),
  `phantom-cli/agentFromConfig.ts` (coding + Assistant in the app),
  `phantom-backend/telegram/assistant.ts` (the Assistant headless — same
  builder, same prompt, handlers over the server's own routes).
- "date appended" = `withCurrentDate(instructions)` at EVERY build (launch,
  resume, model change): `\n\nCurrent date: <Month DD, YYYY>` (en-US). The
  frozen prompt never contains it.
- The coding prompt takes FOUR frozen inputs, all carried by the
  `POST /sessions` response: the skills index, git facts
  (`agent_git_credentials`), the secrets index (names + descriptions, never
  values), and the environment facts line probed from the fs image.

## createAgent.ts

- `ModelConfig {provider, model, baseUrl?, apiKey?, reasoning?, fetch?, onRetry?}`.
  `PROVIDERS` = anthropic | openai | google | openai-compatible. `fetch` is
  a test seam only. `onRetry(note)` receives every failed attempt as it
  happens; absent = silent retries.
- `AgentSpec {instructions, tools, maxSteps?}`; `maxSteps == null` →
  `stopWhen: () => false` (unlimited — spelled out because the SDK default
  is 20). Returns a `RecordingAgent`: `stream`/`generate` take a `record`
  sink spliced onto `onStepEnd` (a caller's own `onStepEnd` still runs) —
  the ONE place usage lines are written; no agent re-implements it.
- Thinking rule (`effectiveReasoning`): `'none'` → `'minimal'` ONLY when
  provider is `anthropic` AND `thinkingAlwaysOn(model)` (`/claude-fable-5/`,
  which 400s on `thinking: disabled`). Any other provider passes `'none'`
  through. `Reasoning` = none | minimal | low | medium | high | xhigh.
- Anthropic subscription tokens: `isAnthropicOAuth(key)` → the request is
  disguised (`anthropicOAuthFetch`, `withClaudeCodeIdentity` prepends
  `CLAUDE_CODE_SYSTEM`, idempotent).
- Retries are OURS, at the fetch layer inside `languageModel`, every
  provider; every SDK call sets `maxRetries: 0`. `withRetry`: waits
  `RETRY_WAITS_S` = 2/4/8/15/30/45/60s (8 attempts, 164s), hard
  `RETRY_BUDGET_MS` 180s; retryable = 408/409/429/5xx, anything else fails
  at once; network error = TypeError only; `retry-after`/`retry-after-ms`
  honored only when longer than the schedule, capped 60s; a non-replayable
  (non-string) body is never retried; gives up by RETURNING the failing
  Response (only network errors rethrow).
- `withCacheBreakpoints(messages)` marks first + last message (Anthropic
  prompt-cache) ON A COPY. Apply it at every conversation-shaped call site
  (the cli's runTurn, the server turn runner, the supervisor's turn) —
  never store the marks.

## agentConfig.ts — the ONE config→agent resolver

- `modelConfigFrom(cfg, modelOverride?)` — the coding agent's ModelConfig
  from the flat settings (`provider model base_url reasoning` +
  `PROVIDER_KEY[provider]` for the key).
- `agentModelConfig(cfg, prefix)` — the CASCADE for `supervisor` /
  `assistant` / `git_fixer`: `<prefix>_model`/`_base_url` fall back to the
  coding agent's ONLY while `<prefix>_provider` resolves to the coding
  provider; a cross-provider override makes `<prefix>_model` REQUIRED
  (`cascade` throws at BUILD, never at write — the store writes one key at
  a time and cannot see the pair). `base_url` never crosses providers.
  `''` and `null` both mean unset.
- `buildCodingAgent(...)` → `{agent, summary{provider, model, reasoning,
  maxSteps}}`; `max_steps` ≤ 0 or non-finite → null (unlimited).

## Prompts (llm/prompts/)

**One mechanism.** A prompt file is a DOCUMENT (`<agent>/<agent>.ts` — text
only, blanks written `{{name}}` where they land) plus a `wiring.ts` beside
it that fills it. `template.ts`:

- `fill(template, vars)`: a blank with no value THROWS; a line whose blanks
  ALL resolve empty vanishes whole (an optional line is written label and
  all, and simply isn't there); values go in last, never re-scanned (JSON
  and diffs are safe); 3+ newlines collapse to 2. Whitespace at the edges
  never matters — of the template or of any value: `fill` trims both, once,
  so a document or a shared block may open and close on blank lines freely.
  Spacing INSIDE a value is verbatim.
- `firstLineOf(template, vars)` = the first line `fill` would SEND (the
  first non-blank line, filled) — the looper's frozen first-message
  discriminators. `llm.test.ts` pins that every fixed loop message starts
  with its own marker and that markers are unique.
- `withCurrentDate` — above.

**Frozen.** A prompt is assembled ONCE when its conversation begins and
frozen with it (the transcript header; the Assistant for the sidecar's
life; a Git Fixer run is one conversation). Editing a document changes NEW
conversations only. Guidance that must reach existing sessions belongs in
a tool's DESCRIPTION, which reaches every turn.

**Shared blocks** (top of `prompts/`): `STAKEHOLDERS` (who is who) and
`VALUES` (the six values) — coding, supervisor, Assistant; `COMMUNICATION`
(the written register) — coding and supervisor; `ENVIRONMENT` (`{{facts}}`
— the container line; empty drops only that line) — coding only; `GIT` (how
code moves: one branch per session, auto-push, no PRs) — Assistant only;
`SENDING_FILES` (`sending.ts` — deliver a file by naming its path, the
`MEDIA:` form; its text scopes itself to Telegram because the same frozen
prompt serves the cli) — coding and Assistant. The Git Fixer carries none.

| document | constants (blanks) |
|---|---|
| `coding/coding.ts` | `SYSTEM` (`stakeholders values communication environment skills secrets credentials sending`) · `SKILLS` (`skillsList`) · `SECRETS` (`secretsList`) · `CREDENTIALS_FACT`. Wiring: `systemPrompt(skills, git, secrets, facts)`, `skillsIndex`, `secretsIndex` — descriptions clip to 60 chars (57 + `...`), so a skill's trigger must live in its first 57 |
| `assistant/assistant.ts` | `SYSTEM` (`stakeholders values git sending`); spoken register, so no `COMMUNICATION`; wiring `systemPrompt()` |
| `helpers/sessionTitle.ts` | `SYSTEM` · `NAME_THE_SESSION` (`recentMessages`) — a one-shot HELPER, not an agent: the auto-titler's pair (`phantom-backend/sessionTitle.ts`); wiring `titleRequest(recentMessages)` → `{system, prompt}`. Runs on the Assistant's model config but belongs to no agent |
| `gitFixer/gitFixer.ts` | `SYSTEM` (`branch sessionId`) · `FIRST_MESSAGE_RECOVER` · `COMMIT_MESSAGE` (`stat diff`); wiring `systemPrompt`, `toGitFixer.recover`, `commitMessagePrompt` |
| `supervisor/supervisor.ts` | every loop-authored message — below |

**The supervisor document is the loop's whole script.** Every fixed message
the looper sends is here, text only; the model never authors one. THE
LAYERING RULE: `SYSTEM` holds only what is true in every phase (no if-thens
on phase); everything phase-specific rides the implanted briefing.

| constant | to | when (looper decides) | blanks |
|---|---|---|---|
| `SYSTEM` | supervisor prompt | build | `stakeholders values communication` |
| `PLAN_CARD` | coder, first message | card in `plan`, empty conversation (plan mode = readonly kit) | `seq card planFormat` |
| `BUILD_FROM_PLAN` | coder | `in_progress` after planning in this session | `seq card reportFormat` |
| `BUILD_FROM_CARD` | coder, first message | `in_progress` with no plan phase — no planning language anywhere (the discriminator depends on it) | `seq card reportFormat` |
| `PLAN_FORMAT` / `REPORT_FORMAT` | both sides | filled into the kickoff ("produce these sections") AND the briefing ("the reply follows this format") — ONE source each | none |
| `IMPLANTED_REVIEWING_PLAN` | supervisor transcript, USER role | implanted before the first copied plan reply; carries the card | `seq card planFormat` |
| `IMPLANTED_REVIEWING_WORK` | supervisor transcript, USER role | implanted before the first copied build reply | `seq cardSection reportFormat contract` |
| `CARD_IS_BACK` | coder | a human moved the card back from blocked/done | `seq resolution` — the answer line vanishes when empty |

`IMPLANTED_` = written into a transcript, never starting a turn.
`{{cardSection}}` and `{{contract}}` are computed by the LOOP from whether
a plan phase happened (`toSupervisor.reviewingWork(card, {planned})`): the
card rides only the briefing that OPENS the conversation, and the contract
line names "the plan approved earlier…" or "the card above" — the model
never infers the phase. Wiring exports `firstLine.*` (the discriminators),
`toCodingAgent.*`, `toSupervisor.*`, `CardShape`.

## session.ts — openSession, THE way anything obtains a session

`openSession({ baseUrl, apiKey, clientId } | { call }, label, workspaceId?,
sessionId?, lock?, fetch? })` → resolve (create when no id / restart by id
when its files are gone / attach) → lock ONLY when `lock: true` (identity
`x-phantom-looper-client`; a definite holder throws `SessionLockedError`)
→ pull the server transcript → resolve the frozen prompt (the header's,
verbatim; else assembled from the create response's skills + git facts +
secrets + environment). Returns `{ info, messages, events, header,
instructions, transcript, saveTranscript, close, created, ... }`.

- `saveTranscript` does NOT await the PUT: it chains onto one in-flight
  promise; failures surface in `close()`, which awaits the chain and then
  releases the lock in a `finally` (the DELETE swallows errors).
- The content-type header is set ONLY when a body exists — a bodyless
  DELETE that claims JSON 400s in Fastify and leaks the lock for a TTL.
- Opening is READING: the cli opens without a lock and locks per turn; the
  looper and the turn route open with `lock: true`.

## transcript.ts — one format everywhere

JSONL: line 1 `{"type":"session", agent: 'coding'|'assistant'|'gitFixer',
provider, model, created_at, system_prompt, ...}` (`system_prompt` = the
frozen prompt; coding headers add `session_id workspace branch`), then one
`ModelMessage` per line; any other line with a `type` is an EVENT
(`{"type":"usage", input, output, cache_read, cache_write}` after each
step; `{"type":"interrupted"}` after a step esc cut — the cli's runTurn
writes that step itself from the stream, every call with the result that
arrived or an "interrupted" stand-in, because its commands already ran),
pinned by `at` = messages-so-far and re-interleaved by
`serializeTranscript`, so a server-side rebuild loses nothing.
Classification order: `type === 'session'` → header; anything with a
`role` → message; else event. A torn last line is skipped; a tool call
without its result is trimmed (`dropDanglingToolCall`) and events past it
dropped.

- `Transcript` (file-backed: cli sessions, the Assistant's
  `~/.phantom-cli/voice/`, the Git Fixer's `work/<session>/logs/`) writes
  the header lazily on first append (`mkdir 0o700`) — a silent run leaves
  no file. `memoryRecorder(startAt)` is the same sink for in-memory
  rebuilds (looper, turn route).
- `sumUsageFromJsonl`, `usageEvent`, `lastUserFromJsonl` (the /resume
  one-liner), `loadTranscriptFile`.

## Tool kits (llm/tools/)

- `presets.ts` `pickKit(tools, mutating, pick = 'full')`: `'readonly'`
  drops the kit's declared mutators, `'full'` keeps all, a name list picks
  exactly those; unknown names throw, and so does a declared mutator
  missing from the kit. Plan mode = the readonly preset on the mutating
  kits.
- `workspace.ts` `phantomTools(...)` — the seven file tools (`bash read
  write edit ls find grep`) from `GET /tools`; `pickTools(defs, names |
  'readonly' | undefined = all)`, driven by the server's per-tool `mutates`
  flag. Its `toModelOutput` turns an image read into an image part and
  hands the raw envelope (`{ok:false,…}`) to the model instead of throwing.
  The SDK abort signal rides into every tool fetch (Esc kills the running
  command — the backend's kill path).
- `skills.ts` `skillTools` — `skill_list` / `skill_load` / `skill_manage`
  (mutator); `skill_load` de-dupes per kit instance (an unchanged reload
  returns a stub). Session header `x-phantom-looper-session`.
- `web.ts` `webTools` — `web_search` / `web_fetch` over `/web/*`; no
  mutators, so plan mode keeps both.
- `secrets.ts` `secretTools` — `secret_list` / `secret_get` over
  `/secrets`; read-only; bound to the session's WORKSPACE at build. Coding
  agent ONLY.
- `kanban.ts` — the headless board kit, thin clients on the card routes:
  `kanbanReadTool` (`kanban_card_read`, the `?seq=` lookup — one card back,
  archived or not); `loopSupervisorTools(cfg, column)` → `kanban_card_move`
  (enum = `SUPERVISOR_MOVES[column]`: plan → in_progress | blocked;
  in_progress → done | blocked) + `kanban_card_items` (tick by key) —
  REBUILD EACH TURN so the enum matches the current column;
  `loopBlockTool` → `kanban_card_block` (sets `blocked_reason`, clears
  `resolution`). `ENDING_TOOLS` = `['kanban_card_move',
  'kanban_card_block']` — the looper reads these names off the transcript
  to know a turn was terminal. All three are bound to THE card at build (no
  card input) and their DESCRIPTIONS carry "THIS ENDS THE RUN".
  `renderCard` makes cli-served and server-served reads identical.
- `tui.ts` — the Assistant's kits (static descriptions; the host supplies
  the handlers — App in the cli, `telegram/assistant.ts` headless):
  `sessionsTool` (`session_list/get_active/switch/read/close`. LIST is the
  SERVER's — every session, not the window's memory: `limit`/`offset`,
  50 default, 100 max, 500 back (App fetches limit+1 as the lookahead and
  slices); each row carries running (`isRunning`, shared with /resume's
  table), on_screen, title, workspace name, card, kind. SWITCH opens ANY
  session through App's one `openSession` path — a swept one restarts;
  ids are EXACT, no prefix matching. READ stays on the window's loaded
  sessions — `renderRead`: 50 messages default, thinking dropped, tool
  results one line unless `tools: true`. CLOSE takes an optional id
  (default: the session on screen) and goes through App's one
  `closeSession` path — out of local memory, the server keeps everything);
  `assistantKanbanTool` (`kanban_screen` — show `board | column | card |
  off`, column = ONE column across the main area (the board's `[e]`), the
  result naming what is on screen;
  `kanban_card_list/read/create/update/move/items/history/pin/auto_plan/auto_build` —
  flipping an auto switch restarts the looper at once; the requirements
  list rides only on create, everything after goes by key through items);
  `codingKanbanTool` (the read only); `screenModeTools`
  (`session_get_mode`, `screen_enter_plan_mode` — one-way);
  `workspaceCreateTool` (`workspace_create_repo`, gated by the client — the app's pane, Telegram's `approvals.ts`;
  `kebabName` is the deterministic final name). `statusEnum` makes
  `status` a real enum of the workspace's columns.
- `server.ts` `fixerBashTool(exec)` — the Git Fixer's `bash`; stdout
  truncated to 8KB, stderr 4KB.

## skills/ — the scanner rules

- ONE level under `.agents/skills/`; dirs and symlinks; `SKILL.md`
  required; a skill with no parseable `description` is silently skipped;
  missing root → `[]`; sorted by name. Identity is the FOLDER name
  (frontmatter `name` is enforced only on write). Frontmatter tolerates a
  BOM and CRLF; `description` supports `|`/`>` block scalars, flattened to
  one line. `mergeSkills` is first-list-wins.
- Two tiers exist, both server-side: the repo's `.agents/skills/` and the
  system skills baked into the fs image at `/opt/skills/`
  (`phantom-backend/systemSkills.ts`); repo wins a collision. There is NO
  personal/laptop tier — sessions must not depend on the machine that
  created them.
- `validate.ts`: name `^[a-z0-9]+(?:-[a-z0-9]+)*$` ≤ 64; description ≤
  1024; SKILL.md ≤ 100,000 chars; a bundled file ≤ 1 MiB under
  `references|templates|scripts|assets`; paths reject `..` and anything
  outside `[A-Za-z0-9._/-]`. `lintSkillMd` warns, never blocks.
