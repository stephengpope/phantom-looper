# phantom-backend/looper/ — the supervisor loop

```
engine.ts       LooperEngine: runLoop (the entry), runAllLoops (boot, a switch change), runLoopOfSession (a lock
                release), runTurn (one owed step), the token budget, blockCard
logic.ts        the pure rules: canTurn, unsentKickoff, needsFreshSession, nextStep, replies, heldBy, LOOP_COLUMNS
turn.ts         runCodingTurn — the one server-side coding turn (kits, cache marks, memoryRecorder, feed publishing,
                the save); drain; sumTokens; settingsValues
injectFetch.ts  a fetch over Fastify's inject, so the core kits reach this server's own routes in-process
```

## Shape

There is no loop object and no polling. The card's status plus the two
transcripts are the state. `runLoop(workspaceId, seq)` is called by every
card write, by a switch change (through `runAllLoops`), by a released
lock (through `runLoopOfSession`), once at boot, and by itself after a
turn ran. Calls on one card coalesce through `running` and `pending`;
different cards run concurrently.

Each iteration re-reads the workspace, the switches and the card, then
asks `canTurn`. Anything else, including a read failure, means no turn.
A turn that throws blocks the card with `looper turn failed: <reason>`,
and blocked is not a loop column, so the loop ends. Nothing retries.

## One turn

1. Find the card's current loop row. Entering `plan` after a status move
   is a new loop; `needsFreshSession` reads the revision clock.
2. Open the coding session with `lock: true` as client `supervisor`. A
   new loop creates the coder, a supervisor session on the coder's folder,
   and the loop row together, names the coder after the card, and publishes
   the pairing on the board feed. Held elsewhere means `skipped`; the lock
   release will re-run the loop.
3. Stamp `agent = coding`. Seed the token budget once per loop from both
   sessions' token-usage; breach blocks the card.
4. If `unsentKickoff` owes a kickoff, run one coding turn with it (plan
   mode when the card is in `plan`) and return `turn`.
5. Otherwise open the supervisor session and ask `nextStep`:
   `supervisor` runs the supervisor with any unsent briefing plus the
   uncopied coder replies as user messages; `deliver` runs the coder with
   the supervisor's reply verbatim; `return` runs the coder with
   `CARD_IS_BACK` and then clears `blocked_reason` and `resolution`.
6. Close both sessions in nested finally blocks. `close()` throws if the
   save did not land, and that is a turn failure like any other.

The supervisor's kit is rebuilt every turn: workspace tools readonly
bound to the coder's session id, `kanban_card_read`, web, and
`loopSupervisorTools` for the current column. The coder gets
`loopBlockTool` through `extraTools`, outside the readonly preset.

## The step rule (logic.ts)

Copies are verbatim, so the state is an ordered text match. `replies`
takes each agent turn's text, skipping turns that called an ending tool.
`repliesReceived` walks the other side's user messages in order. Whatever
is uncopied is owed. Kickoffs and briefings are recognized by their
frozen first lines from `core/llm/prompts/supervisor/wiring.ts`, never by
prose. `heldBy` gives the lock label a locked-out window shows:
planning, building, or reviewing.

## The turn runner (turn.ts)

Used by the engine, `POST /sessions/:id/turn`, and Telegram code mode.
It builds the coding kit (readonly preset in plan mode), marks cache
breakpoints on a copy, streams whether or not anyone watches, publishes
every part on the session feed under the caller's client id, and saves
the whole turn from `memoryRecorder` because the SDK's turn-end response
carries only the final step. `drain` throws the stream's error part so
the model's own words become the blocked reason.

## Tested in

`test/looper-logic.test.ts` (every rule in logic.ts, no server),
`test/looper.test.ts` (the loop end to end with the model scripted at the
wire, the feeds, the turn route).
