# phantom-cli/ — the app

A fullscreen Ink app over phantom-backend. It builds the coding agent and
the Assistant from `/core`, streams them into the terminal, keeps several
sessions open in one window, and reaches the server over HTTP only. It
never imports server code; the tsconfig includes `phantom-backend` so
tests may assert against server modules, production code may not.

```
npm run phantom-cli [-- --resume <id>]   npm run test:phantom-cli   npm run keys
phantom-cli --version | update [--client|--server] | setup-backend
```

```
index.tsx          launch: subcommands, the per-request connection (`api`, `stream`), saved-CA trust, console → cli.log,
                   crash handlers, mouse on/off, render App, the resume line and version notice at quit
App.tsx            the view: the two-pane layout, the screens, the keys and the mouse, and the state only a
                   keypress moves (the typed line, scroll, ctrl+o, ctrl+c arming). Builds the window and draws it
window.ts          WindowStore — the window itself, outside React: the sessions, the boards, the Assistant's voice
                   client, and what is on screen (view, menu, splash, `opening` — a /new in flight blanks the
                   pane so the ghost draws alone — the approval, the window's own notes).
                   `view` carries a card's back destination, so esc has one owner and one answer.
                   Opening, closing and switching sessions; plan mode; the slash commands and submit; boot; the
                   settings every change re-reads; auto-push and auto-pull; the data and re-read clocks behind
                   /resume, /tasks and /archived; refreshIfMoved, the one reseat path
assistantKit.ts    the handlers behind the Assistant's tools (session_*, the board and screen, the gated
                   workspace_create_repo, the two git ones) over the WindowStore, and the kit they compose into
kanban.ts          kanbanOps — the card work both kanban tools do, against one BoardStore
sessions.ts        SessionStore — every open session and the one turn each may run; outside React
session.ts         the local transcript file under CONFIG_DIR/sessions/; adoptServerCopy (the seating rule); syncTranscriptUp
sessionFeed.ts     SessionFeed — the session on screen's live feed, folded into the store as remote turns
follow.ts          followStream — one reconnect policy (1 s → 10 s backoff, 45 s stall cut, an onReconnect refill hook)
board.ts           BoardStore — one workspace's board, optimistic writes, follows the board feed
state.ts           the stream-part reducer (applyPart), block splitting (takeCompleted), finalize, tokens, messagesToParts
turnAge.ts         turnAgeColor — how long a turn has run, in the colour of the spinner already drawn
agent.ts           runTurn — one agent turn with delta batching; the interrupted-step record
agentFromConfig.ts buildAgent / buildAssistantAgent over core's resolver
voice.ts           VoiceClient — the sidecar process, the JSON-lines wire, and the Assistant's brain and history
commands.ts        the slash command table; matches / parse / complete
config.ts          CONFIG_DIR, the local DEFAULTS/META, LOCAL_KEYS, VOICE_BOOT_KEYS, ASSISTANT_MODEL_KEYS
local.ts           the seven machine-local settings in CONFIG_DIR/settings.json; env overrides; 0600
settings.ts        the server settings client: all / patch / clear / read / write
settingLabels.ts   rendering a setting's value (30d, yes); names and meaning come from the server
request.ts         the Api type, requestError (the one sentence a failed request becomes), and quiet()
mouse.ts           the SGR mouse parser, selection ranges, clipboard
screen.ts          the screen mirror (@xterm/headless) behind Ink's stdout; selection highlight; frame tracing
trim.ts            drops the unchanged left part of Ink's row rewrites before they reach the terminal
provision.ts       ssh provisioning: parseTarget, runInstall, readServerFacts, readServerCa, verifyFromHere, apiFor
setup.ts           `setup-backend`: the install wizard on @clack/prompts, no Ink
selfUpdate.ts      APP_VERSION, checkLatest, isBehind, selfUpdate (download, verify, unpack, one symlink)
update.ts          `update` and `--version` and the quit notice; every dependency injected
keys.tsx           `npm run keys`
components/        own map
sidecar/           the Python voice process; own map
```

## Settings have two homes

`LOCAL_KEYS` (server url and key, mic, speaker, headphones, the two mutes)
live in `CONFIG_DIR/settings.json` and are read synchronously with no
network, because they are how the server is reached or facts about this
machine. Everything else is the server's store. Settings are read where
they are used: an agent build, a sidecar spawn, a screen opening. Nothing
holds a resolved settings object except `bootConfig` for the first build.
`CONFIG_DIR` is `~/.phantom-cli` installed and `<repo>/.phantom-cli` from
source; `PHANTOM_CLI_DIR` overrides it and the test script sets it.

## A session in this window

App.tsx is a view over `WindowStore`. The rule that splits them: anything with
a caller that is not a React event lives in the window, because the Assistant
opens and closes sessions and the boot path runs while nothing is rendering.
App keeps only what a keypress moves — the typed line, the scroll offsets, the
ctrl+o and ctrl+c state. The window notifies; App subscribes once and redraws.
Every field the view renders is set through a method that notifies, so no
screen can be left showing a value the window has already changed.

/resume, /tasks and /archived are fed rather than self-fetching, because each
opens fetch-FIRST: a server that cannot answer leaves you on the chat with a
note instead of on an empty screen. Two of them also need facts only this
window has — which sessions are open here, which is mid-turn, this window's
lock id.

`WindowStore.openSession` calls core's `openSession` with the window's `api`, then
seats the transcript file, builds the kit (`newTools` from index.tsx plus
`codingKanbanTool` and `screenModeTools`), takes the frozen prompt from the
header or assembles one, builds the agent, and adds the entry to the store.
Opening never locks. The lock is per turn: `onTurnStart` posts it and
`onTurnEnd` releases it after the transcript upload. A lock held elsewhere
refuses the send with a note that keeps the words.

The seating rule in `adoptServerCopy`: the server copy replaces the local
file, except when the local file is the server text plus more lines. That
is this machine's unsaved steps from a window that died mid-turn, so the
file is kept, shown, and uploaded.

Turns append to the transcript per step through core's `record` seam. An
esc cut writes the step from what streamed, because its tool calls already
ran. Enter while a turn runs queues per session; the queue goes out as one
turn. `/model` and `/plan` rebuild agents; a turn already streaming keeps
the agent it started with.

## Watching a session run elsewhere

One session feed (`sessionFeed.ts`) carries lock, agent, plan mode, git
work state and transcript saves alongside every live turn part. Its opening
snapshot includes the transcript stamp, so reconnects repair missed saves
through `reseatIfMoved`, the one reseat path. Failed transcript reads or
mode rebuilds reconnect through `followStream`; there is no session-state
poll. The switch-time transcript check and send-time lock check remain.
The store's `remoteStart`, `remoteParts`, `remoteEnd` draw watched turns
through the same reducer as local ones. Watching the whole turn keeps its
richer screen when the record lands; a gap repaints from the transcript.
Who holds the session comes from `lock` records into `session.held` and
lapses on this window's clock at `expires_at`. Git still gets measured by
the existing server-side refresh; its changes now ride the session feed.

This window relays its own turn through `SessionStore.relay` so another
watcher sees it the same way. The server never echoes a client its own
events.

## The Assistant

`buildAssistantAgent` uses core's cascade. Its kit is `buildAssistantKit`
(`assistantKit.ts`): the tui kits from core over the WindowStore, plus
`newAssistantTools` (workspace read-only and web) bound to the session on
screen and rebuilt when it changes. Every handler reads the window live, never
a captured value — the agent is built once and must not answer with the
session that was on screen when it was built. The conversation lives
in `VoiceClient.history` and is appended to `CONFIG_DIR/voice/`, never
replayed. A boot-time audio key (`VOICE_BOOT_KEYS`) restarts the sidecar; a
model key (`ASSISTANT_MODEL_KEYS`) rebuilds the brain in place.

`workspace_create_repo` is gated: `WindowStore.requestApproval` puts the ask
in the voice pane, `voice.intercept` claims spoken words while it stands,
the exact word accept or decline answers, the tool's abort declines.

## Drawing

Alternate screen, no scrollback, no `<Static>`. `Pane` is a virtual list
over the session's finished parts; the live block under it is budgeted to
a third of the screen. While a menu is open the live block (streaming
parts, the working line, the queue) is not drawn — its changing height
rode the menu up and down. `state.ts` commits closed markdown blocks as they
stream so only the block being typed re-renders. Every drawn character goes
through `components/Text`, which expands tabs and drops control characters
before Ink measures. `trim.ts` sits between Ink and the terminal and cuts
row rewrites to the changed tail. `screen.ts` mirrors every frame into a
headless terminal so drag-to-select copies what is on screen. Console
output goes to `CONFIG_DIR/cli.log`; Ink's console patching is off. Each
of the four screen regions is wrapped in `Boundary`, so a render throw
costs one region and a note, not the app.

## Errors

`api` and `stream` throw only what `request.ts` builds: unreachable, key
rejected, or the server's own sentence with its code attached. A screen
prefixes what it was doing. Background work that runs again on its own may
fail quietly through `quiet(...)`, which logs; anything a person asked for
fails out loud.

## Tested in

`npm run test:phantom-cli` runs the files listed in package.json; a new
test file must be added there. Suites: `tui` (reducer, a full turn,
seating), `sessions` (the store, queue, lock, relay, feed), `window` (the window
driven with no React at all), `board`,
`menus` (commands and every screen), `voice` (VoiceClient against a
scripted sidecar), `mouse`, `screen`, `trim`, `config`, `settings`,
`session`, `oauth`, `provision`, `setup`, `selfUpdate`, `update`,
`request`, and the component suites under `components/`.
