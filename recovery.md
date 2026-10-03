# Recovery: "Fix SDK conversion and clean up phantom-looper codebase"

Session `01m3w2c1qqpxqapz6j9134z7xc` on 134.199.234.57 (container `phantom-looper-ws-01m3w2c1qqpxqapz6j9134z7xc`, repo at `/workspace/repo`). The transcript hit ~950k input tokens and stopped mid-verification on 2026-10-03 ~20:15 UTC. Written from the last ~400 transcript lines only.

## Git state

- All work is committed. `main` and `agent/01m3w2c1qqpxqapz6j9134z7xc` are both at `266c09a` on GitHub (35 commits fast-forwarded onto `6faa431`, no rebase needed).
- The server's GitHub token cannot push this branch: it changes `.github/workflows/release.yml` and the token has no `workflow` scope. It was pushed from the Mac instead.
- The plan the agent was following is `docs/phantom-agent-sdk-plan.md`.

## Done (committed)

- Steps 1–6: `PhantomBackend.create`, tools by name per agent type, session type + `started_by`, `GitSync` + sweeps, `HttpApi` with route/tool doors, the Telegram split (`TelegramBot` in the SDK, `TelegramAssistantBot` in the app).
- Lifts: `Upgrader`, the update task and upgrade checker moved into the backend SDK.
- Step 7 (`88f9e2e`): looper, cron, Telegram turns, the conflict fixer and the sync summary all run on the client SDK over loopback. `core/llm` is deleted. Dead routes removed (`/turn`, `/lock`, `PUT /transcript`, `/step`).
- Explicit model fallback: each agent type declares `modelFallsBackTo`; a root with no provider resolves to empty values. `POST /sessions` now requires `type`.
- Cron `reasoning` is a column on the session row (one migration).
- Container path `/project` → `/workspace` in the Dockerfile, environment prompt and `SessionContainers`.

## Where it stopped: the live proof of step 7

Run against the real stack with a fake OpenAI-compatible model (`/workspace/scratch/fakeModel.mts`, env in `/workspace/scratch/boot.env`, backend on port 18080).

| Check | Result |
|---|---|
| Card run (coder → supervisor → move) | Passed on the rerun, card 2 reached `in_progress`. The first run looped 600+ supervisor steps; fixed with a `terminal` tool list on the kit and `hasToolCall` as a stop condition. |
| Prompt cron | Passed |
| Script cron | Passed after a fix to `runScript` in `phantom-backend/crons/engine.ts` (now held as a turn) |
| Telegram assistant turn | **Not passing.** `sendMessage('hello assistant')` timed out (exit 124) with the session left locked by `telegram`. The fake model answers every call with `kanban_card_move`, so the assistant turn never ends. The agent dumped that transcript and the context overflowed. |
| Telegram coding turn | Not run |
| Live Telegram proof of step 6 | Not run, needs a real bot token |

## Next

1. Decide whether the assistant-turn hang is only the fake model (it never stops calling tools) or a missing stop condition on the assistant kit, as the supervisor had. Fix the fake model or the kit, rerun.
2. Run the Telegram coding turn proof.
3. End-of-plan rename, workspace → project, including the per-agent `workspace_<id>` databases becoming `project_<id>` (asked at the end; the agent never answered it).
4. `release.yml` is half-renamed: `context: build/project` but `dockerfile: build/workspace/Dockerfile`, and `build/project` does not exist yet. A release tag will fail until the rename lands or the line is reverted.

## Standing instructions from the session

- No tests for this work; proof is the live stack with the fake model, harness stays in scratch, uncommitted.
- Nothing about compaction: do not code it, move it or mention it.
- Bodies are lifted verbatim; functionality stays the same.

## Leftovers in the container

- `fakeModel.mts` is still running (pid 51711, since 19:46).
- A test session `01m41pdvnrgd0gcj52anxe0m0f` in the scratch backend's database is locked by `telegram`.
