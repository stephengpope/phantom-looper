# phantom-looper v1 on phantom-agent-sdk — what is left

phantom-looper is a user-space app on **phantom-agent-sdk**: a client SDK
(`phantom-agent-sdk/packages/client`, `@phantom-agent-sdk/client`) that gives
an app an agent and a session, and a backend SDK
(`phantom-agent-sdk/packages/backend`, `@phantom-agent-sdk/backend`) that
gives a server the services, tables, API and the doors to extend them. The SDK
supports; user space (`phantom-looper/`, `phantom-backend/`, `phantom-cli/`)
is one implementation of that support.

This is the only plan. Done work is not listed; `git log` is the record. The
rules below stand for every step that remains; `docs/multi-user.md` holds the
next piece of work, designed and not started.

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

## What is left

Engineering of the conversion is complete; `git log` is the record. These
remain, in the order they unblock each other.

1. **A hands-on pass of the cli** (the builder): launch, relaunch — the
   Assistant comes back with its conversation; `/new assistant`; a model
   failure shows the words back in the queue. The paths behind these ran
   with a real model; the screens have not been looked at.
2. **Compaction, put back** — parked by the builder's word. Backend-side, on
   the record, under the hold; the existing settings drive it; `/compact`
   works again. The record already has a line type for the prompt moving
   (`system_prompt_rebuilt`); compaction's mark is the same shape of line.
3. **The Telegram Assistant forgets on every backend restart** — waits on 2.
   `TelegramAssistantBot.ensureAssistantSession` keeps the session id in
   process memory. A conversation that only ever resumes needs compaction
   (or a `/new assistant` door) before it may resume for ever.
4. **The backend SDK's lint to zero** — on a machine with memory, or CI; the
   type-checked pass is killed on the dev box. The last report before it
   died counted 41 needless assertions and 19 `no-base-to-string`.
5. **Ship** (the builder's accounts): a real-Telegram proof (a bot token
   stored as a secret); `phantom-agent-sdk/` lifted out as its own repo; the
   npm org; `scripts/release.sh X.Y.Z` then `npm publish` of both packages;
   phantom-looper on the published versions with its own version line; the
   server's GitHub token with `workflow` scope so a release edit pushes; an
   SDK migration dropping the columns the app's migrations 001 and 002 took
   over (another app's fresh install still creates them).
6. **Multi-user** — mail, sign-in, ownership, invites: designed in
   `docs/multi-user.md`, not started.

## Names — keep

`Agent`, `CodingAgent` / `AssistantAgent` / `SupervisorAgent`,
`BackendClient`, `ToolKit`, `SystemPrompt`, `StoredSystemPrompt`,
`PhantomBackend`, `GitService`, `Deployment`, `Looper`, `CronScheduler`,
`TelegramBot` (SDK) / `TelegramAssistantBot` + `TelegramAssistantState` +
`CardAutomation` (app). `resumeSession` / `newSession` / `open` (the
Assistant's) / `addToolKit` / `sendMessage` / `interrupt` / `partialMessage`
/ `connect`. `ownerOnCard` / `ownersByCard`. Server blocks: `soul_md`,
`agents_md`, `skills_list`, `secrets_list`, `time_date`, `github_token`,
`agent_database`. Errors: the backend's code as sent; the SDK's own in
`SDK_ERROR_CODES` (`sdk_version_mismatch`, `tool_loop` among them).
