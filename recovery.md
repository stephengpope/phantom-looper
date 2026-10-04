# Recovery: "Fix SDK conversion and clean up phantom-looper codebase"

The plan is `docs/phantom-agent-sdk-plan.md`. This file is where the work stands against it, kept current as items close.

## Done (committed)

- Plan step 1, both rename passes: `workspace → project` (`4d0b56d`, migration 047 incl. the per-project databases/roles `workspace_<id> → project_<id>`) and `folder → workspace` (`69a524a`, migration 048). `build/workspace/` → `build/session/` (`d8880c9`), the session image's folder; the half-renamed `build/project` references are gone.
- Steps 3 (first half: settings registry, agent-type registry), 4, 5, 6, 7: `PhantomBackend.create`, tools by name per agent type, session type + `started_by`, `GitSync` + sweeps, `HttpApi` with route/tool doors, the Telegram split (`TelegramBot` in the SDK, `TelegramAssistantBot` in the app), `Upgrader` in the SDK. Looper, cron, Telegram turns, the conflict fixer and the sync summary run on the client SDK over loopback. `core/llm` is deleted. Dead routes removed (`/turn`, `/lock`, `PUT /transcript`, `/step`).
- Explicit model fallback: each agent type declares `modelFallsBackTo`. `POST /sessions` requires `type`. Cron `reasoning` is a column on the session row. Container path `/project` → `/workspace`.
- The backend SDK knows no agent type by name: `POST /sessions` makes what the type's registration says (`workspace: own|borrow|none`, `workspace_session_id` for a borrower), `PATCH /sessions/:id` re-points a borrower, `listed: always|background|never` and `config.backgroundStarters` drive the list; `/sessions/assistant`, `/sessions/supervisor`, `/follow`, `LOOP_CLIENT_ID`, `CRON_CLIENT_ID`, `StartedBy` left the SDK. Proven live (assistant, coding, card run, cron, both list filters).

## Live proof of step 7 — all passing (2026-10-04, fake model + fake Telegram, stack in scratch)

| Check | Result |
|---|---|
| Telegram assistant turn (DM → webhook → `TelegramAssistantBot` → `AssistantAgent`) | Passed. Tool call, then an answer in words, reply delivered, lock released. The earlier hang was the fake model never answering in words — product code unchanged. |
| Telegram coding turn (`/new`, `/code`, a message) | Passed. Container on the session image, `ls` ran in the checkout, record complete. |
| Card run (coder → supervisor → move) | Passed, card reached `in_progress`. |
| Prompt cron | Passed |
| Script cron | Passed (run recorded as a turn with exit code) |
| Live Telegram proof of step 6 | Not run, needs a real bot token stored as a secret |

## Left in the plan

- Step 2: SDK folder final shape (`phantom-agent-sdk/packages/client|server`, package names, pinned ranges).
- Step 3, second half: schema split `phantom_agent_sdk` + `phantom_looper`, one ledger each, with `card_automation`, `card_runs`, and the `telegram_bot_state` split.
- Step 7 tail: sort what remains of `core/` (agents, prompts shared by cli and backend); stale comments in `phantom-cli/assistantKit.ts` and `phantom-cli/voice.ts` still name `core/llm/tools/*`.
- Step 8: the broken features (volatile prompt section rebuild, assistant resumes newest row, failed model call returns the user's words).
- Step 9: ship.

## Raised, not in scope

- No default cap on tool calls for the assistant or coder (`max_steps` empty = unlimited, pre-existing): a real model stuck retrying a failing tool runs until the user sets one.
- The server's GitHub token cannot push a change to `.github/workflows/release.yml` (no `workflow` scope); `d8880c9` touches it.

## Standing instructions from the session

- No tests for this work; proof is the live stack with the fake model, harness stays in scratch, uncommitted.
- Nothing about compaction: do not code it, move it or mention it.
- Bodies are lifted verbatim; functionality stays the same.
