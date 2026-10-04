# phantom-looper v1 on phantom-agent-sdk — what is left

phantom-looper is a user-space app on **phantom-agent-sdk**: a client SDK
(`packages/phantom-client-sdk`) that gives an app an agent and a session, and
a backend SDK (`packages/phantom-backend-sdk`) that gives a server the
services, tables, API and the doors to extend them. The SDK supports; user
space is one implementation of that support.

This is the only plan. It replaces `phantom-agent-sdk-plan.md` and
`recovery.md`. Done work is not listed; `git log` is the record.

## Words

- **Project** — a registered repo: base branch, branch prefix, board.
- **Workspace** — a checkout: files, branch, container. Owned by one session;
  other sessions may borrow it.
- **Session** — a conversation on a workspace, of one agent **type**. The
  SDK knows a type only by its registration (tools, model settings, whether
  it owns or borrows a workspace, when it is listed). The three types —
  `coding`, `supervisor`, `assistant` — are this app's.
- **Actor** — who a client acts for (`x-phantom-looper-actor`): a person when
  unsaid, else an automation's name (`looper`, `cron`, `telegram`). Recorded
  as a session's `started_by` and `last_turn_by`.
- **The record** — the session's transcript on the backend, typed lines.
- **Looper** — the card-run policy over the board. User space.

## Where it stands

Both renames done. The SDKs own boot, storage, the API, git, Telegram
plumbing, the runtime and the tool surface; `PhantomBackend.create(config)`
→ `start()` is the only way in. Every backend turn runs on the client SDK
over loopback. Every object, function and variable has a word for a name.
Proven live with a fake model and a fake Telegram API; a real Telegram
proof needs a bot token.

## The rules that stand

Every step below is held to these. A step that cannot be done inside them
stops and asks; it does not bend them quietly.

**Functionality does not change.** This is a conversion, not a rewrite.
What the customer sees and what the system does — every command, every
screen, every list, every reply, every default — is the same before and
after each step. Bodies are lifted verbatim. The only functionality changes
are the ones a step names outright (step 4's four fixes, each a change the
builder asked for), and each lands as its own commit with the change in the
message. Anything that would alter behaviour as a side effect — a default
that moves, a route that answers differently, a filter that hides a row it
used to show — is raised before it is written, not discovered after. The
record of the conversion so far has two such changes that were found in
review, not announced (`started_by` ownership, auto-compaction); that does
not happen again.

**Proof, not belief.** No step is done until it has run on the real stack —
the harness in scratch, a fake model and a fake Telegram API where a real
one is not available — and the proof is named in the commit. "It
typechecks" is not proof.

**The simplest right thing.** One source of truth, one rule, one function,
one object per concept. Complexity earns its place only with a reason
written down and a payoff the customer feels; a lock, a migration, a second
copy of a fact, a shape bolted onto one that no longer fits — each is named
as a cost before it is taken, and discussed with the builder when the cost
is not obviously worth it.

**Objects own their facts.** A table has one owner; a service has one
object; nothing reaches around an object to its storage or its wiring.
Private stays private (`#field`, `private readonly`); what is public is
public because something outside needs it. An app enters the SDK through
`PhantomBackend.create(config)` → `start()` and the backend's public
objects — never a second door. The SDK knows no app by name: not a type,
not an actor, not a tool, not a column.

**A name says what the thing is.** Objects, functions, variables, columns,
routes, settings. One name per object, the owner's — no aliases, no second
word for a thing that has one. No one- or two-letter names except a loop
index (`i`, `j`) and a comparator's pair (`a`, `b`). A thing that has a
standard name keeps it (`sid`, `pid`, `dm` is NOT one — it is `chatId`).
A rename is a rename: the old word is gone everywhere, comments and docs
included, in the same commit.

**Nothing is hidden.** What a step did, what it did not do, what it found
along the way and did not touch — all of it is in the commit message and in
the report to the builder, the important thing first. A guess is called a
guess. A mistake found later is reported as a mistake, with the fix.

**The builder decides the deviations.** Scope, a behaviour change, a new
dependency, a schema change beyond the one a step names, a name for a
concept that has none yet, deleting anything, pushing anything — asked
first, with the choices laid out as what each one feels like to the
customer and what each costs the code. Everything else — a mechanism
proven by reading the code, a convention the values already settle — is
decided and reported.

**Compaction is parked** until step 4 puts it back: its settings stay,
nothing triggers it, nothing moves or redesigns it in passing.

**No tests for this work**: proof is the live stack; the harness stays in
scratch, uncommitted.

## 1. The schema split — SDK tables and app tables

The SDK's tables move to schema `phantom_agent_sdk` with their own
migrations folder and ledger, shipped in the backend SDK package; this
app's tables stay in `phantom_looper` with theirs (`config.migrations`).
No user-space column on an SDK table. Today three app facts sit on SDK
tables:

| today | after |
|---|---|
| `cards.auto_plan`, `cards.auto_build`, `projects.auto_plan`, `projects.auto_build` | `phantom_looper.card_automation` (card_id / project_id, auto_plan, auto_build) |
| `sessions.card_id` | `phantom_looper.card_runs` (session_id, card_id) — `coderOf`, `newestOnCard`, `codersByCard` read it |
| `telegram_bot_state.mode`, `active_session_id`, `active_project_id` | the SDK keeps the link row (webhook, secret, bot username); `phantom_looper.telegram_assistant_state` holds the bot's behaviour |

With them go the last app words in the SDK: `kanban_card_auto_plan` /
`kanban_card_auto_build` tools, the board route's `auto_plan_default` /
`auto_build_default`, `telegram_bot_state.mode`. The board itself (cards,
items, revisions, columns) is the SDK's. One migration moves live data;
proven on a copy of a real database before it lands. A pure move: every
route answers the same JSON, every tool has the same contract, every
screen reads the same — the app's facts simply live in the app's tables.
Where the move would force an API shape to change, that is raised first.

## 2. The SDK folder takes its final shape

`packages/phantom-client-sdk` → `phantom-agent-sdk/packages/client`
(`@phantom-agent-sdk/client`); `packages/phantom-backend-sdk` →
`phantom-agent-sdk/packages/backend` (`@phantom-agent-sdk/backend`).
Dependency ranges pinned (today's `*` is monorepo-only). The app imports by
the new names. A pure move: `git mv` and import paths, no body changes. `core/` — the three agents, their prompts, `sessionRows` —
is the app's shared code (cli and backend both run it) and moves to
`phantom-looper/` beside `phantom-backend/` and `phantom-cli/` so the
repo's top level reads as: the SDK, the app.

## 3. The lockstep rule, enforced

Client and backend SDK are one version. `/health` reports the backend
SDK's version; `BackendClient` compares it to its own at connect and
refuses with a clear error on a mismatch. Apps need no guard of their own
for the API surface (phantom-looper's update gate stays for its own two
halves).

## 4. The broken features, fixed inside the SDK's structure

The four functionality changes of this plan — each asked for, each its own
commit, each proven live, each with its customer-visible effect stated in
the message. The design of each is proposed to the builder before it is
built.

- **The Assistant forgets everything each launch.** The cli opens a new
  assistant row every time. Resume the newest assistant row for the
  project; `/new` is the way to start fresh. Smallest change, most customer
  pain — first.
- **The prompt's volatile section is frozen at create** (date, skills,
  secrets). A rebuild rule: `sendMessage(text, { rebuildSystemPrompt: true })`
  carries the layout in turn-start; the backend reassembles under the hold,
  answers the new sections, a record line marks it. Who triggers it (resume?
  a day boundary?) is decided then.
- **A model call that fails after retries drops the user's words.** Put them
  back to the host.
- **Compaction, put back.** It ran before the conversion (the Telegram
  assistant compacted automatically); nothing triggers it now. Backend-side,
  on the record, under the hold; the existing settings drive it; `/compact`
  works again.

## 5. Loose ends from the review

- No default cap on tool calls: `max_steps` empty = unlimited, so a model
  stuck retrying a failing tool runs until a person sets one. Decide a
  default or a circuit breaker.
- Auto-push's error hides git's words ("could not back the branch up"
  when GitHub refused the token's scope). Surface the reason.
- `Disk.test.ts` rides in the backend SDK with no runner. Delete, or give
  the SDK a runner and make it the first test.
- Backend SDK lint: 84 pre-existing errors (casts, unused imports). Clean
  to zero before the package ships.
- The fuzzy-edit and diff helpers (`tools/fuzzy.ts`, `tools/diff.ts`) are
  lifted third-party-shaped code; name their locals or mark the files as
  vendored.

## 6. Ship

- A real-Telegram proof of the bot (needs a bot token stored as a secret).
- README and setup for each package; migrations in the backend package;
  the lockstep release script.
- `phantom-agent-sdk/` lifted out as its own repo; the npm org;
  phantom-looper on published versions with its own version line.
- The server's GitHub token gets `workflow` scope so a release edit pushes.

## Order

1 (schema split) before 2 (folder shape) — the split lands in the package
that moves. 4's first item (assistant resumes) can go any time and should
go first. 3 and 5 are small and independent. 6 last.

## Names — keep

`Agent`, `CodingAgent` / `AssistantAgent` / `SupervisorAgent`,
`BackendClient`, `ToolKit`, `SystemPrompt`, `StoredSystemPrompt`,
`PhantomBackend`, `GitService`, `Deployment`, `Looper`, `CronScheduler`,
`TelegramBot` (SDK) / `TelegramAssistantBot` (app). `resumeSession` /
`newSession` / `addToolKit` / `sendMessage` / `interrupt` /
`partialMessage`. Server blocks: `soul_md`, `agents_md`, `skills_list`,
`secrets_list`, `time_date`, `github_token`, `agent_database`. Errors: the
backend's code as sent; the SDK's own in `SDK_ERROR_CODES`.
