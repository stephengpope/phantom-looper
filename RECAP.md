# RECAP: Client SDK work (session 01m38s1j86ap7wpp1sg8xfj7wr)

Where the session "Migrate Client SDK and Server SDK Implementation" stands, as of 2026-09-24.
It stopped at 07:41 UTC, 184 turns in.

## Where the discussion left off (the last ~20 messages)

1. **Client SDK list finished.** After `87aba1e` was pushed to main, the user had the client SDK list done first. The result was: `say` → `sendUserMessage`; pull the queued messages at turn start, with `PHANTOM_PULL_USER_MESSAGE_QUEUE=off`; nothing given back on failure; `inject` removed; README updated; old plan doc deleted. That work is commit `f40ad6d`. The tests were not run, on the user's order.
2. **Moved on to the server SDK (phantom-backend).** The user asked for the "how each message reaches the AI" table:
   - **Tasks** (background command finished): queued by phantom-backend, pulled at the next turn.
   - **Instant sync:** queued the same way.
   - **File uploads:** not an injection; the file path goes into the user's own message.
   - **Auto-push / auto-pull:** phantom-backend writes the summary straight into the transcript, holding the lock. This breaks after the switch, because whole-file transcript saves go away.
3. **The user's key point (the live topic):** "there isn't a solid consistent strategy for getting messages inserted." The auto-push method works well. It holds the lock, which comes naturally, and the message is inserted ahead of time, with no queue.
4. **Proposal on the table (not approved, not built):** one strategy for everything. Every message the system has for the AI goes straight into the transcript, under the lock. Tasks and instant sync switch from the queue to direct insert. If a turn is running, phantom-backend holds the message and writes it in when that turn releases the lock (it already reacts to lock release, `routes/sessions.ts:231-233`). The client SDK needs nothing new, because every turn already re-reads a changed transcript. What would go away: the queue, the pull at turn start, `PHANTOM_PULL_USER_MESSAGE_QUEUE`, and the drain route, including the pull just built into the SDK. The one cost: a held message is lost if phantom-backend restarts while holding it. The current queue has the same weakness.
5. **Last exchange: user messages sent from the client SDK.** The user asked whether messages sent during a turn are recorded only in the client SDK. They are, while they wait. The user pushed back on a long list of "states", and the answer settled on two:
   - **In the queue (waiting):** client SDK memory only, invisible to other windows, lost if the program closes. A voice note still being transcribed sits in the queue and holds up everything behind it.
   - **Out of the queue:** it went into a model call. If the call succeeds, it's written into the transcript. If the call fails, it's gone. The only other way out is `/pop`.

**Next:** the user decides on the single-insert strategy (item 4). That decision shapes all the phantom-backend work and whether the SDK's pull at turn start stays.

## Ground rules settled in the session

- The client SDK (`packages/phantom-client-sdk`) is one reusable agent object. phantom-cli and phantom-backend will both run it. It must not make decisions that belong to the program using it.
- Nothing in the app uses the client SDK yet. No switch-over has happened.
- A failed message is never written to the transcript, and nothing is removed later. The failure just comes back, and the program using the SDK decides whether to retry.
- The whole system prompt is frozen when a session is created. That's deliberate.
- The new transcript layout (add-only lines) was requested and stays.
- Sessions are shared. The lock is held for one turn at a time, and every turn must work from the latest transcript.

## Done in the client SDK

Commit `87aba1e` is on `main`. Commit `f40ad6d` is only on this branch and has not been merged to `main`.

1. The summary model's API key now comes from the summary model's own settings. Before, it failed whenever the summary model came from a different provider than the main model.
2. Each turn checks whether the transcript changed and re-reads it if it did.
3. The SDK no longer keeps its own copy of the session's model or checks against it. It reads the model from phantom-backend's settings.
4. A failed message isn't kept or resent.
5. No turn starts by itself after a stop.
6. Read-only tools use each tool's own read-only mark, replacing three hand-written lists.
7. The date is worked out in one place (`src/prompts/date.ts`).
8. There's one copy of the request code (`call` is built on `callRaw`).
9. `say()` was renamed to `sendUserMessage()`. It works the same way: it starts a turn when none is running, and otherwise joins the next model call. A message still waiting when a turn ends starts the next turn.
10. At the start of each turn, the SDK pulls in the messages phantom-backend queued for the session (a task finished, instant sync). `PHANTOM_PULL_USER_MESSAGE_QUEUE=off` stops the pull. If the turn fails, nothing is given back.
11. The public `inject()` was removed.
12. The README was updated, and `docs/client-sdk-implementation.md` was deleted.

**Status:** lint and typecheck were reported clean. The tests were updated but **never run**, on the user's instruction.

## Open: not decided or not built

1. **A single way to insert messages (discussed last, not approved or built).** The user pointed out that auto-push/pull writes its summary straight into the transcript while holding the lock, with no queue. The proposal is to use that method for everything: tasks and instant sync too. phantom-backend would hold a message while a turn is running and write it in when the lock is released. If adopted, it removes the queue, the pull at turn start, `PHANTOM_PULL_USER_MESSAGE_QUEUE`, and the drain route, including the pull just added to the SDK (item 10 above).
2. **Compaction (parked by the user).** The SDK still summarizes automatically after a turn (`#afterTurn` → `#compact` in `agent.ts`) and has a public `compact()`. The user's direction is that compaction is its own agent type in the SDK and runs only in phantom-backend. The user said to leave this question for later.
3. **The SDK still calls `/backdoor/drain`,** because that's the only route that exists today.

## phantom-backend work (not started)

- If item 1 above isn't adopted: rename `BackdoorQueue` to `UserMessageQueue` (`injectUserMessage`, `drainUserMessageQueue`), and rename `/backdoor/drain` to `/user-message-queue/drain`. phantom-cli's `drainBackdoor` call changes in the same step.
- Auto-push/pull currently writes into the transcript by saving the whole file (`index.ts:187-207`). That breaks once whole-file saves go away, so it needs the new insert method (item 1) or the queue.
- Routes the SDK needs that don't exist yet (`test/fakeBackend.ts` shows how each should behave):
  - `POST /sessions/:id/transcript/append`
  - `PUT /sessions/:id/frozen`
  - `POST /sessions/:id/turn-ended` for every session, not only the assistant's
  - `POST /sessions/supervisor`
  - `GET /sessions/:id/transcript` with the line count
- The card runner (`looper/engine.ts:365`, `447`, `465-479`) calls compaction and never saves the result. The user said it should not compact, so this code should come out.
- Several comments wrongly say dropped files go through the backdoor queue (`api/backdoor.ts`, the drain route, `docs/instant-sync.md`, and phantom-cli's `window.ts`, `paste.ts` and `drop.ts`). File paths actually go into the user's own message.

## Suggested next step

Settle open item 1 first, since it decides both the phantom-backend work and whether the SDK's pull at turn start stays. Then run the SDK tests.
