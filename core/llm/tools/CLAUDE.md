# core/llm/tools/ — the tool kits

Every tool an agent can call is built here. A kit is a function that returns
`Record<string, Tool>` (AI SDK tools). Two shapes:

- **headless kits** talk to phantom-backend over HTTP themselves. They take
  `{baseUrl, apiKey, sessionId | workspaceId, fetch?}`; `fetch` is the test
  seam. Session-scoped calls send `x-phantom-looper-session`.
- **host-handled kits** (`tui.ts`) only declare schemas and descriptions; the
  caller passes the handler that does the work (App in the cli,
  `phantom-backend/telegram/assistant.ts` headless).

```
presets.ts     pickKit(tools, mutating, pick) — 'full' | 'readonly' | [names]. readonly drops the
               names the kit declared mutating. Unknown names throw. Plan mode = readonly on every kit
workspace.ts   phantomTools — bash read write edit ls find grep. Definitions come from GET /tools
               (phantom-backend/tools/registry.ts); each becomes a POST /tools/<name>. Image reads become
               image parts; the {ok:false} envelope is returned to the model, never thrown
skills.ts      skillTools — skill_list, skill_load (dedups an unchanged reload), skill_manage (mutating)
web.ts         webTools — web_search, web_fetch over /web/*. Nothing mutates; readonly keeps both
secrets.ts     secretTools — secret_list, secret_get over /secrets?workspace=. Read-only. Coding agent only
kanban.ts      the headless board kit: kanbanReadTool (kanban_card_read via ?seq=), loopSupervisorTools
               (kanban_card_move + kanban_card_items), loopBlockTool (kanban_card_block). renderCard is the
               read shape both this and the cli's handler return
git.ts         autoPushSession / autoPullSession — the only readers of the /git/auto-push and /git/auto-pull
               streams. Not tools; the Assistant's git tools (tui.ts) and the slash commands call these
tui.ts         host-handled: sessionsTool (session_*), assistantKanbanTool (kanban_* + kanban_screen),
               codingKanbanTool (kanban_card_read only), screenModeTools, workspaceCreateTool,
               gitAutoPushTool, gitAutoPullTool, renderRead (session_read's text)
server.ts      fixerBashTool — the Git Fixer's bash over a ContainerExec. stdout 8KB, stderr 4KB
```

## Who carries which kit

| agent | kit | assembled in |
|---|---|---|
| coding | workspace + skills + web + secrets + kanban_card_read; in a loop run also kanban_card_block | `phantom-backend/looper/turn.ts`, `phantom-cli/index.tsx` |
| Assistant | tui.ts kits + web + workspace readonly | `phantom-cli/App.tsx`, `phantom-backend/telegram/assistant.ts` |
| supervisor | workspace readonly + kanban_card_read + web + loopSupervisorTools | `phantom-backend/looper/engine.ts` |
| Git Fixer | server.ts only | `core/llm/agents/gitFixer.ts` |

The coding agent has no git tool and no card move. Landing code on base is
a person's call (slash commands, the Assistant). Moving a card is the
supervisor's or a person's.

## The loop-bound tools (kanban.ts)

`loopSupervisorTools` and `loopBlockTool` take a `LoopCardConfig`: the card
is fixed at build, there is no card input, so an agent in a loop can only
act on its own card. `kanban_card_move` offers only `SUPERVISOR_MOVES[column]`
(plan → in_progress | blocked; in_progress → done | blocked), so it must be
rebuilt each turn as the column changes. `ENDING_TOOLS` names the two calls
the looper treats as ending a run; it reads them off the transcript. The
"THIS ENDS THE RUN" contract lives in the descriptions because a
description reaches every turn and a frozen prompt does not.
`clientId` rides writes as `x-phantom-looper-client`, which is how the
server tells the loop's move from a person's.

## tui.ts, why the handler is outside

`session_list` is the server's list (the window only knows what it opened).
`session_switch` goes through App's one open path so any session can come
on screen. `session_read` renders what the window holds. The board tools
edit the same BoardStore the screen draws from, so an edit repaints. The
descriptions are static; mode and screen state are a tool call away, never
rewritten into the schema.

## Tested in

`test/llm.test.ts` (every kit on a capturing fetch, pickKit, the abort
signal), `test/looper-logic.test.ts` (the loop-bound tools' enums and
descriptions), `phantom-cli/*.test.tsx` (the tui kits through App's
handlers).
