# phantom-cli/ — the app

THE product: a fullscreen Ink terminal app over phantom-backend — AI SDK
agents over the core tool kits, streaming into Ink, several sessions open in
one window, server-side transcripts, slash commands, the /kanban board, and
the **Assistant** in a pane on the right (a second agent in this process;
its ears and mouth are the Python sidecar — `sidecar/CLAUDE.md`). A client
of the HTTP API and `/core` ONLY: never imports server code; every
server-side rule in `phantom-backend/CLAUDE.md` applies unchanged.

```
npm run phantom-cli                     # new session (workspace picker if several; none → add a workspace)
npm run phantom-cli -- --resume <id>    # back into a session
npm run test:phantom-cli                # headless (ink-testing-library + scripted agent/sidecar/brain); a new test file must be added to the script
npm run typecheck                       # tsc --noEmit && tsc -p phantom-cli (this tsconfig includes ../phantom-backend for test assertions)
npm run keys                            # press keys, see what the terminal sends
phantom-cli --version | update | update --server     # headless subcommands (index.tsx)
```

## Settings — two homes, and a row says which

- **Local** (`CONFIG_DIR/settings.json`, `local.ts`, sync, 0600 chmod'd
  after every write; a corrupt file is REPORTED, never rewritten): the seven
  `LOCAL_KEYS` — `server_url server_key voice_mic_device voice_speaker_device
  voice_headphones voice_mic_muted voice_speaker_muted`
  — because they are how you REACH the store or facts about this machine.
  Env reaches exactly two: `PHANTOM_BACKEND_URL`
  (server_url), `PHANTOM_BACKEND_KEY`/`API_KEY` (server_key) — the only
  `env` entries in `config.ts` META; nothing loads a file into env (the
  repo's `.env` is compose's, the cli never reads it). Local screens
  (`/server`) must never need the network.
- **`CONFIG_DIR` is the one root** every file the cli owns hangs off:
  `~/.phantom-cli` installed, `<repo>/.phantom-cli` (gitignored) from source
  (`APP_VERSION === 'dev'`). Dev and installed never share a byte; setup.sh
  seats the dev server's url + key in the repo one. Never build a
  `~/.phantom-cli` path by hand — import `CONFIG_DIR`.
- **Server** (`settings.ts`, async): everything else — the model config,
  the Assistant's trio, the voice keys, `sidebar_width`, `boot_last_workspace`
  (server-only, not in config.ts), the credentials — ordinary keys of the
  one flat store. A read that cannot reach the server THROWS.
- **Settings are read where they are used, never held.** `settings.ts`
  (`read/write/all/patch/clear`, one method per route) is the ONLY file
  that names a `/settings` path — `settings.test.ts` scans the tree and
  fails the build otherwise. It hands out no resolved object: `startVoice()`
  reads at spawn, an agent build reads at build, a screen reads when it
  opens. The one exception is `bootConfig`, used for the FIRST agent build
  only.
- Names and meaning come from the server (`META[key].label`, `choiceLabels`,
  `DESCRIPTIONS` in `phantom-backend/settings.ts`); `settingLabels.ts` only
  renders values. `config.ts` carries `DEFAULTS/DESCRIPTIONS/META` for the
  local keys, `VOICE_BOOT_KEYS` (deepgram key + devices: a change restarts
  the sidecar) and `ASSISTANT_MODEL_KEYS` (a change rebuilds the Assistant
  in place, history kept).

## Commands (`commands.ts` — the table; `matches/parse/complete`)

Tab completes a `/` line; a command with `args` takes the rest of the line
and the menu steps aside once you type a space; `parse()` resolves an
unambiguous prefix at submit. The live menu shows `MENU_ROWS` (8) slots,
always rendered, blank when unused. Everyday commands come first in
`COMMANDS`; `/archived` sits late on purpose.

| command | what |
|---|---|
| `/new` | another session in this workspace |
| `/resume` | the server's session list, lazily: one page of `PICKER_PAGE` (30) at open, the next appended when the cursor nears the bottom (SelectList's `onNearEnd`, NEAR_END = 10 rows out; cursor = the last SERVER row's `lastUsedAt`+id via `GET /sessions?typed=true&supervisor=false&limit&before&before_id`; a short page = the end). WHAT is listed is the server's call — never-typed sessions and supervisor seats are filtered THERE, so a page is a page on screen, and the server's `total` drives the `↓ N more` line. The one client addition: sessions open in THIS window with nothing typed yet, merged onto the end and counted (the switcher must never hide an open session). The list is `pad`ded to the window, so its height never changes as pages land. `[s]` flips `supervisor` and re-reads — the looper's supervisor seats; opening one is READ-ONLY. Columns `ws · card · session · last message · work · who · when` (ws = card prefix; card = the bare card number from the row's loop, `·` when none — beside the prefix `PHA  7` is the board's PHA-7; session = the model-written title, `·` unnamed; work = `not pushed`/`not merged`/`merged` behind a colored `•` (red = only on the server's disk, yellow = on origin not in base, green = in base), `·` when nothing to measure — from `GET /sessions?git=true`, which the OPEN fetch never carries: the list paints instantly and the git-inclusive refresh right behind fills the words in place; who = supervisor/coder/manual — `whoDrives(row)` off the row's `agent` ALONE, never the card: the server sets `agent` from who saved the last turn, so a card session you type into reads `manual` from its next save, its card number kept, and `coder` again once the looper drives it; one function, shared with the Assistant's `session_list` `kind`). Activity is a two-cell LEFT-EDGE marker (spinner = a turn running here or elsewhere; `•` = loaded, idle); rows in motion sort first. Re-reads every `pollMs` (10s) — however many rows are loaded. `[d]` duplicates (the way past a holder — name + manual mark travel), `[x]` CLOSES (the /close path), `[t]` trashes (unpushed work refuses once, again discards) |
| `/workspace` | switch or add a workspace (`[n]` = the add row, from any row); `e` on a row = that workspace's settings. Adding an EXISTING repo is a picker, not a field: `NewWorkspace` fetches `GET /github/repos` once and renders the /model combobox shape — a filter field over a padded SelectList, rows `owner/name · private/public · pushed <ago>` (or `already a workspace`, which refuses enter), whatever is typed as an `add “…”` row of its own for a repo the token cannot list. No token (`not_set`) or GitHub unreachable falls back to the plain URL field with the reason as the notice. A rejected POST returns to the step it came from with the list kept |
| `/kanban` | the board in the left pane. Keys: arrows select, `n` new, `p` pin, `a` archive, `e` expands the focused column across the whole main area (`e` again or esc collapses; ← → walk the expanded view between columns — a flag on the focus, not a second selection), `v` opens /archived, tab/shift+tab move the focused card a column, `j/k` sort within the column, enter/click edits, esc one level back (expanded → columns → chat). The help footer is `↑ ↓ ← →  [enter] open  [tab/shift+tab] move  [j/k] sort  [n]ew  [p]in  [a]rchive  [e]xpand  [v]iew archived  [esc]` (`[e] collapse` while expanded) — two spaces between items, no separators; a key that starts its word folds into it; esc stands alone — and wraps rather than truncates (the columns shrink to fit it). Only the columns on screen are hit-tested (`shown`) — a ref for a hidden column is a stale node. Rows render `<seq>-<title>` (the prefix is in the header); pinned rows carry `•` in the gutter. Renders from `board.ts` BoardStore — the same object the Assistant's board kit and the coding agent's `kanban_card_read` use, so any edit repaints; a write from anywhere else (the looper, the supervisor, another window) comes down the store's event stream (`follow()` on `GET /workspaces/:id/events`) and repaints the same way — nothing polls. `view` in App is `chat | board | {card}`: a card opened from chat stands alone, from the board it sits over the board |
| `/archived` | the workspace's archived cards, a Screen page like /tasks (also `[a]` on the board, which leaves the board first — a menu lives in the chat view): `card · was in · when` via tableChoices, the hint block reading the highlighted card's story. Its OWN fetch, never part of the board download: `?archived=only`, newest change first, paged like /resume (one `PICKER_PAGE` at open, `onNearEnd` appends via `before/before_id`, a short page = the end; `pad`ded; `↓ N more` counts against the server's `total`). `[r]` restores (a direct PATCH; the notice names the destination) — the card returns to the column it was archived from, which can wake the looper; `[enter]` seats the card in the BoardStore (`adoptCard`) and opens its solo editor (esc from there is chat). The store never holds the archive on its own: a `bySeq` miss in kanbanOps falls back to the `?seq=` lookup and adopts the answer, so the Assistant's `kanban_card_read`/`_update` reach archived cards, and `load()` keeps adopted archived cards across a reload (or an open archived card's editor would close mid-edit) |
| card editor | rows: Title · Story · Details · Requires · (Blocked · Resolution — blocked column only) · Auto plan · Auto build (cycle inherit → on → off) · **Session** (the card's current loop's coding session by title; enter/click opens it) · Pinned · Archived. Keys `[tab/↑↓] move · [enter] next · [ctrl+e] tick · [esc] back`. AUTO-SAVES: a 600ms debounce PATCHes changed fields (`saving…/saved ✓` in the header corner), esc flushes and closes — no Save/Cancel. A save that did not land — rejected, or answered with the difference still open — says `save failed — edit to retry` and is never re-sent by itself. New checklist items are keyed client-side (core's `newKey`) and the diff compares items through one canonical shape: a server-minted key or jsonb's field order would otherwise read as an unsaved change forever |
| `/tasks` | what runs in this session's container: one row per started command under `command · status · started · ended · pid` (pid = the sid `[k]` targets; `ended` blank while running); finished rows under a dim `finished` heading with exit codes; strays say so. Columns via `components/table.ts` (fixed widths — a refreshing list must not jitter). `[k]` kills — warn once, again acts. Re-reads every `pollMs`. The toolbar ALWAYS carries the count (`» code mode on · PHA-7 · 2 tasks`), refreshed after every turn and every `taskPollMs` (60s). The count is THIS session's container, never another's |
| toolbar | the one line under the prompt, about the session on screen ONLY — what is TRUE of it, never a running commentary: `» code mode on · 2 tasks · PHA-7`, plus ctrl+c arming, plus (while someone else holds it mid-turn) who is working, a spinner, and what they are doing: `coding agent ⠹ building`, `supervisor ⠹ reviewing`, or just `⠹ macbook-pro` when the holder is not one of our agents. Interrupting lives on the working line (StatusLine), beside the turn it stops. The card mark is the board's own name for it (`PHA-7`), resolved once when the session opens from the row's `card` (its loop) and the workspace's `cardPrefix`; a session that belongs to no card shows nothing |
| `/plan` | plan mode on/off for the session on screen: `PATCH {plan_mode}` first (every window agrees), then this window rebuilds the coding kit with the readonly preset. Takes effect next turn. The toolbar ALWAYS names the mode. `screen_enter_plan_mode` is the agents' one-way on-switch; only /plan comes back |
| `/close` | close the session on screen — out of local memory: it leaves the tab ring, the ctrl+n list and its `•` on /resume, and the session you spoke to most recently takes the screen (through `switchTo`, like any switch). Nothing on the server changes — /resume opens it again unchanged; [t] trash is the destructive one. Close the LAST session and a new one opens in the same workspace: /close means "done with this", never "leave me looking at nothing". Refused while a turn runs there (the stream's `onParts` closes over that entry). ONE path for every door — `/close`, `[x]` on /resume, the Assistant's `session_close` (by id, or the one on screen) — App's `closeSession(id?)` returns the facts (`closed`, `on_screen`, `opened_new`, or `error`) and each door renders them where its user is looking; `SessionStore.close` removes the entry and, if it was the active one, leaves `activeId` EMPTY so the store never becomes a second way to change what is on screen |
| `/rename <name>` | `PATCH {name}` marks the session manual (the titler never overwrites); blank clears back to auto-titles |
| `/auto-push` | this session's work onto base, streamed as notes; always pushes, ignores `auto_push_on_archive` |
| `/model` | provider, model, reasoning, steps per turn (server-wide) |
| `/server` | api url + key on THIS machine — offline by design, it's where you pair an existing server or fix the address; the save is LIVE (index.tsx reads the file per request), no relaunch |
| `/settings` | the server's settings; overridable ones marked ↯ pointing at the workspace screen |
| `/keys` | the server's credentials, ONE place each, read from its credential namespace (a key declared server-side appears by itself): `github_token` (checked against GitHub on save via `/github/whoami`), the four provider keys, `deepgram_api_key`, `firecrawl_api_key`, `telegram_bot_token` |
| `/secrets` | the coding agent's secrets, every layer in one tagged list. `[n]`/`[enter]` open `SecretEditor` — a popup with explicit Save, esc KILLS (the one place esc-saves inverts); Where cycles global + every workspace; edit re-enters the value whole (the server never hands one back). `[d]` deletes at the row's layer. Needs no session |
| `/voice` | the Assistant: on/off, pane width, provider + model + endpoint (catalog follows the Assistant's provider, else the coding agent's), spoken voice, mic, speaker (re-scanned on open), headphones, wake word + words + timeout, the two mutes |
| `/mic` `/speaker` | mute toggles (also ctrl+r / ctrl+l, always on; clicking `● mic`/`● speaker` in the pane is the same) |
| `/headphones` `/wake` | the two mode switches (clicking the pane glyphs is the same; no ctrl chords — free keys are scarce) |
| `/assistant <text>` | type to the Assistant |
| `/help` `/exit` | |

Keys: enter submits (queues while a turn runs) · esc interrupts (kills the
running command; the cut step still lands in history and the transcript —
its calls ran) · tab / shift+tab next / previous open session · ctrl+n the
open-session list · ↑/↓ history, or the command list on a `/` line ·
ctrl+o show more (thinking, and a tool's whole command and output) · ctrl+g
the voice pane · pageUp/Down scroll · ctrl+c twice quits. Mouse: wheel
scrolls the pane under the cursor; click-drag selects and copies on
release. Free ctrl keys on paper: `e f g k l n p r t u v w x y`; verify
with `npm run keys` — Apple Terminal sends shift+↑ as ↑ (which is why the
open-session list is ctrl+n and ONLY ctrl+n) and swallows ctrl+x.

## Files

```
index.tsx          launch: config chain, headless subcommands (--version, update, update --server), `setup-backend`
                   (the install wizard, then exit — NO first-run gate: unpaired opens the app, the boot note says
                   /server or setup-backend), the connection read from the file per request (`connection()`),
                   saved-CA trust re-applied when the address changes (`trustSavedCa`), mouse on/off, patchConsole OFF (console → CONFIG_DIR/cli.log),
                   crash handlers (uncaughtException + unhandledRejection → cli.log, screen down, the error on the real terminal, exit 1 —
                   Node's own print lands on the alternate screen and is discarded; out of memory aborts from C++ and no handler sees it),
                   render <App boot> at once with incrementalRendering; resume line + quit-time version notices on exit
App.tsx            the whole screen: two Panes, the in-flight block/prompt/toolbar, menus, session store wiring,
                   tool handlers (kanbanOps, screenOps, session_*), keys, mouse. State: `view` (chat|board|{card}),
                   `menu` (null|settings|keys|secrets|model|server|voice|workspace|resume|addWorkspace|
                   workspaceSettings|sessions|tasks); useInput gated on `menu === null && view === 'chat'`
sessions.ts        SessionStore — every open session and the one turn each may run; OUTSIDE React; ordered by last message SENT;
                   `close(id)` removes one (refused mid-turn) and clears activeId — App picks what comes next
session.ts         transcript wrapper over core: CONFIG_DIR/sessions/<id>.jsonl, adoptServerCopy (the seating rule, below),
                   syncTranscriptUp, lastUserMessage
state.ts           stream-part reducer, block splitting, finalize, token estimate (applyTokens), messagesToParts
agent.ts           runTurn (delta batching 150ms screen / 0 speech, onStepEnd); re-exports core/llm + oauth helpers
agentFromConfig.ts buildAgent / buildAssistantAgent over core agentConfig (the SAME resolver the looper uses); onRetry → a note in the session
voice.ts           VoiceClient: sidecar process (findUv/installUv, `uv sync --frozen`, spawn, kill the group), the JSON-lines wire,
                   AND the Assistant's brain (history, turn(), interrupted/spoken handling, intercept for the approval gate) — outside React
follow.ts          the ONE follow policy — connect, reconnect (1s→10s), the 45s stall watchdog, an onReconnect gap-fill hook;
                   shared by the board's feed and the session's
sessionFeed.ts     SessionFeed — one session's live feed while it is on screen: records → SessionStore (remoteStart/Parts/End),
                   any publisher's; batching, and the "did we see the whole turn" flag that decides whether the turn-end record repaints
board.ts           BoardStore — one workspace's board, outside React; optimistic update/move (fractional pos); one per workspace;
                   `follow()` holds the workspace's `/events` stream for the life of the store: each record is adopted like the
                   store's own edits (card written → replace, deleted → drop, session → the Session row); a dropped link reconnects
                   with ONE `load()` to fill the gap; `create()` seats the POST's answer through `adoptCard` (replace by id) because
                   the stream delivers the row first
ndjson.ts          ND-JSON records off a response body — auto-push's stream and the board's events (`stream()` in index.tsx)
commands.ts        the table + matches/parse/complete
config.ts local.ts settings.ts settingLabels.ts   above
modelCatalog.ts    /model picker: models.dev, bundled models-snapshot.json fallback, 24h cache; sync, never throws, never a fence
mouse.ts screen.ts trim.ts   the mouse parser + selection model · the screen mirror (@xterm/headless) · cell-level row trimming
provision.ts setup.tsx selfUpdate.ts   the setup-backend engine (no Ink, injectable runner) · its screens driver (install only) · APP_VERSION + self-update
keys.tsx           npm run keys
components/        Text (THE one Text — every drawn character is cleaned here) · Screen (THE page frame) · Boundary (the error boundary — see Conventions) · SelectList · table.ts · TextInput · ValueInput · Prompt · Toolbar · StatusLine · Pane ·
                   Parts · Markdown · Shimmer · Divider · Banner · Board · CardEditor · Archived · Tasks · Launcher · SessionSwitcher ·
                   NewWorkspace · Settings · WorkspaceSettings · Keys · Secrets · SecretEditor · VoicePanel · Setup
sidecar/           the Python voice process — its own map
```

Tests, one line each: `tui` reducer/shimmer/batching/a full turn, the tool
row's row budget, no 2J/3J ever, resume seating (unsaved local steps kept
and uploaded; a server that moved on wins) · `session` (`adoptServerCopy`
alone) · `board` render, drag, auto-save, keys, Session row, the
archived-cards fetch · `menus` commands, Launcher, /tasks geometry,
/archived, settings screens — imports the server's real settings module so
a lost META entry breaks it · `sessions` the store, ring, queue, sync/lock,
the spinner off the feed's lock records, the working line from a mid-turn
join, the relay, the live feed · `voice` VoiceClient against a scripted
sidecar AND brain, the approval gate · `mouse` · `screen` · `trim` (streams
replayed into two emulators, cell-equal) · `config` · `settings` (the tree
scan) · `oauth` · `modelCatalog` · `provision` · `setup` · `selfUpdate` ·
`components/SelectList` (fixed hint height, cursor normalisation, ctrl/meta
filtered) · `TextInput` · `ValueInput` · `SecretEditor` (never auto-saves)
· `Parts` (summarizeOutput, clipRows) · `Markdown` (inline markdown inside
tight list items) · `components/Text` (tab stops, control characters
dropped, the tree scan) · `components/Pane` (the first message is
reachable; the per-frame cost is flat at 20,000 messages; the tail is
exact).

Env read here: `PHANTOM_BACKEND_URL`, `PHANTOM_BACKEND_KEY`/`API_KEY`,
`_VERSION` (→ APP_VERSION, 'dev' from a checkout: never nags, never
updates), `_TRACE_FRAMES` (screen.ts flight recorder), and the rig hooks
`_INSTALL_FLAGS`, `_SSH_ACCEPT_NEW`, `_SSH_IDENTITY` (setup.tsx).

## Conventions — each one was paid for

- **A throw while drawing costs one region, never the app.** React unmounts
  the whole tree on a render throw and Ink exits — a label with no length in
  the session list killed a running turn (2026-09-03). App wraps its four
  regions in `Boundary` (the menu overlay + prompt, the board, the
  conversation pane, the voice pane): the stack goes to cli.log, the message
  goes where messages go (a note in the conversation, via `note`), the region
  draws nothing, and it comes back when its `resetKey` changes (menu closed,
  view changed, session switched). No notice of its own, no retry. The
  process-level handlers in index.tsx remain the last net for throws OUTSIDE
  drawing (stream callbacks, timers), which a boundary cannot catch.

**Sessions and turns**
- Several sessions are open at once; `App` is a view over the active one.
  Conversations live in `sessions.ts`, outside React; `onParts` closes over
  the entry it started for. A background turn that ends marks its session
  `unseen`; the SessionSwitcher (ctrl+n) is where you see them — the toolbar
  speaks for the session ON SCREEN only. The ring is ordered by last message
  SENT, so tabbing never reorders it. Quitting aborts EVERY session (an open
  request elsewhere would hang node).
- Opening NEVER locks (opening is reading). The lock is per TURN: POST at
  turn start, DELETE after the turn-end sync, every id released on quit;
  client id minted per window, label = hostname.
- **The seating rule** (`adoptServerCopy`): `CONFIG_DIR/sessions/` is
  working memory; the server copy replaces the local file on open and on
  every elsewhere-pull, with ONE exception — a local file that is the
  server's text plus more lines is this machine's unsaved steps (a window
  that died mid-turn: steps append as they run, the upload is at turn end).
  That file is kept, shown, and uploaded at once, with a note under the
  banner. A file that diverges, is shorter, or is the same is replaced —
  the saved turns are the record. The whole file ships at turn end
  (chained per session; failures noted once per streak).
- The prompt never locks: enter QUEUES per session and the queue goes out
  TOGETHER as one turn (several user messages in one request); ↑ on an
  empty line takes the last queued line back; esc drops the queue, esc
  again stops the turn — a running bash is KILLED in the container via the
  SDK abort signal; an interrupted turn never fires the queue.
- A session locked ELSEWHERE is read-only here, WATCHED and STREAMED, two
  mechanisms with one job each. **The WATCH:** every `pollMs` one `GET
  /sessions/:id` carries the transcript stamp and plan mode; a moved stamp
  pulls and reseats whole turns (`reseatIfMoved` — the one reseat path:
  turn start, switch, watch, feed). It carries NO lock state: who holds the
  session comes off the feed's `lock` records into `session.held`, and
  lapses on this window's clock at the hold's `expires_at` (the
  once-a-second countdown tick notices) — a holder that died without
  releasing never spins here for ever. **The FEED** (`sessionFeed.ts`, `GET
  /sessions/:id/events`, the session on screen only): every part of a turn
  run ANYWHERE ELSE — the server's own turns, another window's relayed turn
  — folded through `remoteStart/remoteParts/remoteEnd` into the same
  reducer and the same live region a local turn uses, minus the esc hint
  and with `busy` false. Deltas batch at `FLUSH_MS`. The turn-end refresh
  rides the feed's `transcript` record, not the poll, and KEEPS THE SCREEN
  when this window saw the whole turn (`reseat` takes parts or null): the
  record still brings history, the local file and the stamp, but a repaint
  would drop the thinking and tool timings a transcript cannot carry.
  Anything less than a clean watch — joined mid-turn, a reconnect, a
  clipped tool result — repaints, note and all, as does a turn whose
  `turn-end` never came. Joining mid-turn still runs the working line: the
  first PART marks the session remote-busy; `turn-start` is not required.
  This window never hears itself: the server drops a subscriber's own
  events, so no client-side echo check exists. **THE RELAY**
  (`SessionStore.relay`, `POST /sessions/:id/events`): this window's own
  turn goes up as it runs — turn-start with the message, each `FLUSH_MS`
  batch of parts, turn-end (an `error` when the turn threw with nothing on
  the stream) — one request behind the other so order holds, turn-end
  awaited BEFORE the transcript upload so a watcher sees the turn close and
  then the record land. The first failed request ends the relay for that
  turn and nothing is noted: the relay is not the turn, and the watcher
  repaints from the record. **The toolbar SPINS** (`spinWho`/`spin`): WHO
  from the lock record's `agent`, WHAT from its `label` (the loop's
  `heldBy`: planning / building / reviewing); a holder that is not one of
  our agents leaves just `⠹ <hostname>`. Enter is refused with the line
  KEPT (`not sent — a turn is running (building)`); the send-time lock
  refusal in the store is the backstop.
- The window opens with ZERO sessions; boot is App's own effect through the
  same openSession `/new` uses, so a launch failure is words in the pane
  (`windowNotes`) and `/keys /settings /model /server /workspace /resume`
  all work before a session exists. `boot_last_workspace` (server, global)
  skips the picker into the workspace of the newest session the USER drove
  (`lastWorkspaceId` ignores looper-run sessions — `agent` set — and deleted
  workspaces; a card session you took over counts, its `agent` is null).
  The launch splash (`Banner`, the wordmark under the session header) fills
  any session with nothing said yet — boot's first and every /new; the
  first interaction clears it; a resume shows its history instead.
- Transcript appended per STEP (`onStepEnd`); a torn last line is skipped
  on load, a dangling tool call cut. Cache marks go on copies.

**Screens**
- Every page renders inside `Screen`, and only `Screen` knows the page
  shape: margins, title, ONE always-rendered status line (error > notice >
  busy > sub), the key footer (`FooterKey` pairs via `keyLine`; esc says
  `close` top-level, `back` inside a flow), and the row budget
  (`BudgetContext` from `SizeContext`) that `SelectList` sizes from — no
  `visible={N}` constants. A page that wants to look different argues with
  Screen, not with its own margin. A new browse screen is Screen +
  SelectList in the /resume shape, never a hand-rolled pane.
- No UI component library (every Ink satellite is unmaintained;
  `ink-spinner` is the one import). `SelectList` and `TextInput` are ours.
  `TextInput` treats a key as text only if it looks like text; ctrl/meta
  and unhandled named keys fall through; cursor from a ref (two keys in one
  batch); cursor to the end of a replaced value.
- `SelectList` ignores `key.ctrl/meta` before `onKey` (Ink reports ctrl+c
  as `c`); normalises the cursor on read (React reuses it across choice
  swaps); sizes its label column to content, capped and truncated — a row
  is one line; `labelWidthFor = min(32, widest) + 2`. `initial` names the
  row the cursor starts on: every settings screen (Settings,
  WorkspaceSettings, Keys, Secrets) remembers the row it opened and passes
  it back, so the list returns from an editor onto the setting you changed,
  never to the top.
- **THE COLUMN LAW: a gutter is `paddingRight` inside a fixed
  `flexShrink={0}` box — never leftover space.** When a row overflows the
  terminal, yoga reclaims spare space and squeezes shrinkable boxes first,
  so gaps vanish and columns jitter row to row. With every column pinned —
  cursor, marker, label, each width'd column — overflow can only truncate
  the row's TAIL, the free last column, never a gap. SelectList.test.tsx
  pins it: no rendered line may match `/…\S/`. The header is a ROW: a
  heading Choice WITH `columns` renders through the same boxes as the data
  rows (tableChoices emits titles at the rows' widths) — a padded header
  string is a second copy of the geometry and disagrees with the rows the
  moment the table outgrows its pane. A cell may carry a `mark` (an Ink
  color): a colored `•` in a pinned two-cell box ahead of the dim text,
  counted inside the column's width — a SIBLING of the text, never nested
  in it (Ink applies the parent Text's dim over the child's color).
- A menu gates App's `useInput` (`menu === null && view === 'chat'`) — Ink
  delivers a key to every active handler. ctrl+c, ctrl+r, ctrl+l ride their
  own always-on handler (`exitOnCtrlC: false`; first ctrl+c interrupts and
  closes menus, second quits).
- Key hints are bracketed: `[enter] change · [d] undo`. A row names its
  subject (`delete Widgets`, never "this"). Two levels are two screens,
  never two rows in one list (`/settings` vs `e` on `/workspace`). Helper
  text is concise and literal. Mode and status indicators show state at
  all times, never conditionally. In the card editor every feature row
  gets `marginTop 1`.
- Status line, Claude Code's shape: `⠹ Working… (44s · ↓ 1.7k tokens ·
  thinking) · [esc] to interrupt` — the one key that acts on the turn ends
  the turn's OWN line (`[esc] clears the queue, then interrupts` while
  lines are queued); the toolbar under the prompt stays facts-only. Tokens
  estimated from streamed text (~4 chars) and snapped at each
  `finish-step`. A thought draws nothing while streaming; finished it is
  `∴ Thought for 4s` (ctrl+o shows text). A finished turn leaves `✻ Worked
  for 2m 14s · finished 3:42 pm` (part kind `worked`). Finished parts
  render as markdown once; only the in-flight block re-renders as text,
  budgeted to a third of the screen (`liveRows`).
- A tool row is budgeted in RENDERED ROWS, never in lines (Codex's exec
  cell is the shape): the command keeps its HEAD (its row plus two,
  `CMD_ROWS`), the output its TAIL (`OUT_ROWS` 5 — the tail is what the
  server keeps too; failures are at the end), each cut marked `… +N lines
  (ctrl+o)`, and a spilled command names its `full_output` file.
  `clipRows` is that one rule (it bounds the live text block as well); the
  live region's `maxRows` shrinks the budget further. ctrl+o lifts it — a
  cut with no way to the rest is a bug. A result that is not a log is a
  LINE, never its JSON: `42 lines`, `7 matches`, `2KB written`, `1
  replacement, exact · +2 −1` (edit's diff is counted, not shown), `5
  results` — the fallback that stringifies an object is for shapes
  `summarizeOutput` has not met.
- Voice pane header is three lines: `voice · listening` / `● mic · ●
  speaker` / `● wake · ● headphones` (off = dim `⊘`; the wake window shows
  yellow `● active 6s` counting down); single-cell glyphs only (~20 columns,
  floor 16); while `detail` stands both switch rows hide together; clicking
  a glyph is its slash command (measureElement hit-test, release without
  drag). Per-stage ttfb lives behind ctrl+o.

**Rendering — flicker is layout shift plus whole-row rewrites**
- Alternate screen, drawn live, nothing to scrollback: no `<Static>`, App
  never writes escape codes (a test pins no 2J/3J); history is only
  reachable through `Pane` scrolling.
- `Pane` is the one viewport; three findings against Ink 7.1 must stay:
  content in ONE wrapper Box (bare Text rows under a clipped bottom-aligned
  Box lose a row), scrolling up is a NEGATIVE bottom margin, not a spacer,
  and a pane with no height draws NOTHING (Yoga lays out no children under
  a 0-row box; every item measures 0 and the window walks the whole list
  until React's nested-update limit — Pane.test.tsx pins the squeeze). It
  is a VIRTUAL list: only the items near the view are laid out — above AND
  below — so a frame costs the size of the screen, not the conversation
  (laying out everything is ~380ms per scroll step at 2,000 messages; the
  window holds ~50ms at any length). Each drawn item reports its height
  (`useBoxMetrics`) and the pane remembers it by `keyFor` (the part's id —
  measurements survive a reseat and a session switch); an item never drawn
  is guessed at the measured average and corrected the moment it is drawn,
  one screenful before it reaches the view, so only `maxOffset` into
  never-seen history is ever approximate. A caller must not move its
  scroll in REACTION to `onMeasure` — that is a render→scroll→render loop
  React refuses; scrolling is an input event (`scrollBy` in App: the one
  clamp, shared by the wheel and the two keys, for both panes). `topGap`
  (the chat pane sets it) is ONE blank row of padding above the content,
  so whatever fills the pane first never touches the top edge; it is
  layout, not a blank item some path can forget, and it scrolls away with
  the content.
- Ink diffs by ROW (a row spans both panes). Four things hold flicker down,
  all measured with byte captures: (1) every menu region holds ONE height
  while on screen — the slash menu renders every slot, `SelectList`'s hint
  block is exactly `HINT_ROWS` (clipping in Ink needs one `flexShrink={0}`
  wrapper; menu rows are `truncate-end`); (2) the Assistant's pane repaints
  at `FLUSH_MS` (`paintLive`); (3) `trim.ts` between Ink and the terminal
  drops the part of a row rewrite the row already holds (rows tracked
  relatively; any escape outside Ink's set passes through and drops
  memory; a row is trimmed only when the style state entering it was
  default both times); (4) `incrementalRendering: true`, with a
  repaint-on-resize.
- **Every drawn character goes through `components/Text`, never Ink's
  Text** (Text.test.tsx scans the tree). Ink measures a tab as ZERO cells
  and the terminal draws it up to eight wide: a tab in a tool result makes
  the row wider than laid out, it wraps, and Ink's relative cursor moves
  put every row below one line low for the rest of the session. Text
  expands tabs to 8-column stops and drops the other control characters
  BEFORE Ink measures.
- Console output never reaches the screen: `patchConsole` erases and
  repaints the whole screen per line, so it is OFF. A part's `id` is ours
  (`nextId`) for life; the provider's rides in `sid` only to match deltas —
  a provider id as a React key repaints the whole screen per delta.
- The app owns the mouse (`\e[?1002h\e[?1006h`, off on every exit path).
  Ink hands a report to EVERY `useInput` as `"[<64;10;5M"` with no flags —
  any handler that inserts text checks `isMouseInput()`. Selection text
  comes from the screen mirror (`screen.ts`), never React state; the tty
  turns `\n` into `\r\n` and the emulator does not (mirror it); the
  emulator parses asynchronously, so the highlight repaints from its write
  callback.

**The Assistant (app side)**
- `buildAssistantAgent`: the Assistant's trio cascading to the coding
  agent's (core's rule), reasoning `none`, its own prompt, the `session_*`
  tools (read = compact history from the store, newest first; close = App's
  `closeSession`, the /close path), the board kit on the workspace on
  screen, and the READ-ONLY workspace tools (`newAssistantTools` →
  `phantomTools(pick:'readonly')`: read ls find grep) bound to the session
  on screen and rebuilt when the screen switches — it reads that session's
  checkout, never writes it. Its own `ModelMessage[]` lives in
  `VoiceClient.history`, appended to `CONFIG_DIR/voice/<engine
  start>.jsonl` on the shared format, never loaded back — a restart is a
  fresh conversation.
- The sidecar never sees the model; the app never touches audio. `turn`
  from the sidecar (the aggregated turn text — `user` lines are for the eye)
  → `runTurn(flushMs=0)` streams `speak_start/delta/end` per step.
  `interrupted` aborts the stream; `spoken {turn, step, text, interrupted}`
  swaps the step's recorded text for what was heard (`truncateAssistant`)
  or appends it — the model remembers what you heard. A new `turn` while
  one runs replaces it. `warn {message}` from the sidecar is a line in the
  pane and nothing else; `error` is the engine giving up and flips the
  status.
- All four switches (`voice_mic_muted / voice_speaker_muted /
  voice_headphones / voice_wake_word`) are SETTINGS: a toggle writes the
  setting and goes through `onConfigChange` like the `/voice` screen, is
  pushed live (`mic`/`speaker`/`set`), and survives restarts (mutes ride
  the spawn env and come back in `ready`). Audio keys arrive in the spawn
  env (`VOICE_BOOT_KEYS` → restart); model keys rebuild the brain in place.
  Devices are chosen BY NAME (indexes change between reboots).
- `workspace_create_repo` is gated in the pane: three rows under the
  chat's tail (`new private repo?`, the subject on its OWN row, `accept ·
  decline`) — the subject is `kebabName`, deterministic, never the model's
  guess; answer by clicking or by SAYING the exact word (`VoiceClient.intercept`
  claims everything reaching `turn()` while an ask stands). No keyboard
  chord, nothing modal; the tool call's abort declines; `approvalRef`
  updates synchronously (the next tool call can land before a re-render).
  Always private.

**setup-backend and update**
- `setup.tsx` (`phantom-cli setup-backend`) installs a NEW server and exits;
  pairing an existing one is /server in the app. It runs one screen per
  answer with provisioning BETWEEN screens outside Ink — system ssh owns
  the tty, our code never sees a password, host-key checking is never
  disabled (`accept-new` only via the rig env). `provision.ts` pipes
  `scripts/install.sh` over stdin (script version = cli version), reads the
  pairing back over the same channel, verifies `/health` FROM THE LAPTOP,
  then pushes the model key.
- `selfUpdate.ts`: launch checks run in the background and print at QUIT
  only; `update` = download → checksum verify → unpack beside → move the
  ONE symlink; the running process is never touched.
