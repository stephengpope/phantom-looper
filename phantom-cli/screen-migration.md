# Screen → Overlay Migration — DONE

## What this is

One field on the window store, `overlay`, says which screen is on top of
the chat. An overlay is `{ size, name, render, onDismiss?, poll? }`
(window.ts). `size: 'full'` takes the whole column (every menu, the board,
a card's editor); `size: 'third'` takes the bottom third with the
conversation still above it (/tasks, the duplicate's model pick). One more
field, `dialog`, is THE yes/no — it sits at the bottom of the column on top
of whatever is there, and the screen under it stops taking keys
(components/useInput.ts). Every overlay and the dialog are built in
`screens.tsx`; the store shows them with `showOverlay` / `confirm(...)` and
everything closes the same way: `dismissOverlay` / `dismissDialog`.

## Why

The CLI had three mechanisms for "something on top of the chat": a `screen`
union with a 16-case dispatch, typed-`c`-into-the-prompt confirmations, and
the overlay field added half-way. Three gates for the keyboard, two clocks,
two places to read "is the board up". Now there is one of each.

## The shape

- `render(main)` is a FUNCTION, not an element. It runs on every App render
  and reads the store's current data — so a poll landing on `/tasks`, a page
  appended to `/resume`, a rejected add-workspace form's error all show up
  without re-opening the screen (and without remounting it, which would lose
  the cursor or what was typed).
- `poll` is the overlay's own re-read clock. `showOverlay` starts it,
  `dismissOverlay` stops it; `recover()` fires it once on reconnect.
- `onDismiss(result)` fires AFTER the field is cleared, so it may show another
  overlay. `confirm(title, message?)` wraps this as a promise: enter → true,
  esc / anything replacing it → false.
- The board and a card's editor are ONE component (`Board`) under ONE
  Boundary slot, so swapping the board overlay for a card overlay keeps the
  columns mounted — your place on the board survives editing a card. A card
  opened FROM the board is still named `board` (esc goes back to the
  columns, `boardUp` stays true for the Assistant); a card opened from the
  chat or the archive is named `card` (esc goes to the chat).
- Every destructive key asks the same way: `/trash`, `/restart`, [t] on
  /resume, [k] on /tasks, [a] on the board, [enter] on /presets and the
  agent's `session_code_mode` all go through `confirm()`. enter is yes, esc
  is no; ctrl+c or the screen under it leaving answers no.

## What was removed

`Menu`, `ScreenName`, `screen`, `setScreen`, `closeScreen`, `menuUp`,
`closeCard`, `menuClock`, `editing`, `cancelDuplicate`,
`closeWorkspaceSettings`, `promptTrashArmed`, `promptRestartArmed` and the
two typed-`c` blocks in `submit()`, the `MenuScreen` switch, App's three-way
column branch, and the four in-screen "[c] to confirm" arms (`trashArmed`,
`killArmed`, `archiveArmed`, `applyArmed`).

## Adding a screen

A builder in `screens.tsx` returning an `Overlay`, and the store method or
slash command that calls `showOverlay(thatScreen(this))`. Nothing else.

## Future: agent questions

A coding-agent question is `windowStore.confirm(...)` or a new inline
builder (a select list, a text input) — `showOverlay` + `onDismiss`. No new
mechanism.
