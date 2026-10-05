# phantom-looper v1 on phantom-agent-sdk — what is left

phantom-looper is a user-space app on **phantom-agent-sdk**: a client SDK
(`phantom-agent-sdk/packages/client`, `@phantom-agent-sdk/client`) that gives
an app an agent and a session, and a backend SDK
(`phantom-agent-sdk/packages/backend`, `@phantom-agent-sdk/backend`) that
gives a server the services, tables, API and the doors to extend them. The SDK
supports; user space (`phantom-looper/`, `phantom-backend/`, `phantom-cli/`)
is one implementation of that support.

This is the only plan. Done work is not listed; `git log` is the record (the
2026-10-04 run: `4f603e4`..`1873157` and the two after). The rules below
stand for every step that remains.

## Words

- **Project** — a registered repo: base branch, branch prefix, board.
- **Workspace** — a checkout: files, branch, container. Owned by one session;
  other sessions may borrow it.
- **Session** — a conversation on a workspace, of one agent **type**. The
  SDK knows a type only by its registration. The three types — `coding`,
  `supervisor`, `assistant` — are this app's.
- **Actor** — who a client acts for (`x-phantom-looper-actor`): a person when
  unsaid (`person`, the client SDK's one word), else an automation's name.
  Recorded as a session's `started_by` and `last_turn_by`.
- **The record** — the session's transcript on the backend, typed lines.
- **Looper** — the card-run policy over the board. User space.

## Where it stands

The SDK's tables live in `phantom_agent_sdk` with their own ledger; the app's
in `phantom_looper` with theirs (`config.migrations`). Client and backend are
one version, enforced at build and at connect. The Assistant resumes its
conversation; a resumed session rebuilds its volatile prompt section; a
failed model call hands the user's words back; a stuck tool trips a breaker.
Proven live with the dev stack and a database carried through the split.

## The rules that stand

**Functionality does not change** except where a step names the change, each
as its own commit with the change in the message. Anything that would alter
behaviour as a side effect is raised before it is written.

**Proof, not belief.** No step is done until it has run on the real stack
and the proof is named in the commit. "It typechecks" is not proof. The
machine the work runs on has limits: the type-checked eslint pass over the
backend SDK is killed for memory there and takes the session down with it —
run it on a machine with room, or in CI, never casually.

**The simplest right thing.** One source of truth, one rule, one function,
one object per concept. Complexity earns its place only with a reason
written down and a payoff the customer feels.

**Objects own their facts.** A table has one owner; a service has one
object; nothing reaches around an object to its storage or its wiring. An
app enters the SDK through `PhantomBackend.create(config)` → `start()` and
the backend's public objects — never a second door. The SDK knows no app by
name: not a type, not an actor, not a tool, not a column.

**A name says what the thing is.** No one- or two-letter names except a loop
index (`i`, `j`) and a comparator's pair (`a`, `b`); a thing with a standard
name keeps it (unified diff's `a`/`b`). A rename is a rename: the old word is
gone everywhere, in the same commit.

**Nothing is hidden.** What a step did, did not do, found and did not touch —
in the commit message and the report, the important thing first.

**The builder decides the deviations.** Scope, a behaviour change, a new
dependency, a schema change beyond the one a step names, deleting anything,
pushing anything — asked first.

**Compaction is parked.** Its settings stay; nothing triggers it; nothing
moves or redesigns it in passing.

**No tests for this work**: proof is the live stack. The backend SDK has a
runner now (`npm run backend-sdk:test`, node's) for what is cheap to prove
without the stack; nothing heavier runs on the dev box.

## 1. Decisions waiting on the builder

The schema split is complete. The cards' switches moved (`card_automation`,
through the `CardFieldsExtension` door — the pattern for any app fact the SDK
must carry on its own output); `sessions.card_id` stays in the SDK by the
builder's decision — it is how a card is tied to the agents working it.

- **The Telegram Assistant forgets on every backend restart** — the same bug
  the cli had, left: `TelegramAssistantBot.ensureAssistantSession` keeps the
  session id in process memory. Not fixed because Telegram has no door to a
  fresh conversation and no compaction, so a conversation that only ever
  resumes would eventually hit the model's limit with no way out. Fix with
  compaction, or give the bot a `/new assistant` first.
- **The backend SDK's lint.** Pre-existing errors remain (the last report
  counted 41 needless assertions and 19 `no-base-to-string` before it died);
  the pass needs a machine with memory. Clean to zero before the package
  ships.

## 2. Compaction, put back

Parked by the builder's word this run. When it comes: backend-side, on the
record, under the hold; the existing settings drive it; `/compact` works
again. The record already has a line type for the prompt moving
(`system_prompt_rebuilt`); compaction's mark is the same kind of line.

## 3. Ship

- A real-Telegram proof of the bot (needs a bot token stored as a secret).
- `phantom-agent-sdk/` lifted out as its own repo; the npm org; the first
  `scripts/release.sh X.Y.Z` and `npm publish` of both packages;
  phantom-looper on the published versions with its own version line.
- The server's GitHub token gets `workflow` scope so a release edit pushes.
- The SDK's own migrations, for a fresh install of another app: 012/031
  still create the three Telegram pointer columns this app's migration 001
  takes away; an SDK migration should drop them once every install has run
  the app's.

## Names — keep

`Agent`, `CodingAgent` / `AssistantAgent` / `SupervisorAgent`,
`BackendClient`, `ToolKit`, `SystemPrompt`, `StoredSystemPrompt`,
`PhantomBackend`, `GitService`, `Deployment`, `Looper`, `CronScheduler`,
`TelegramBot` (SDK) / `TelegramAssistantBot` + `TelegramAssistantState` (app).
`resumeSession` / `newSession` / `open` (the Assistant's) / `addToolKit` /
`sendMessage` / `interrupt` / `partialMessage` / `connect`. Server blocks:
`soul_md`, `agents_md`, `skills_list`, `secrets_list`, `time_date`,
`github_token`, `agent_database`. Errors: the backend's code as sent; the
SDK's own in `SDK_ERROR_CODES` (`sdk_version_mismatch`, `tool_loop` among
them).
