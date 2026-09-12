# Screen → Overlay Migration

## What this is

A unified overlay system for the phantom-looper CLI. One field on the window
store (`overlay`) controls what's showing on top of the chat. Inline overlays
replace the prompt zone (the conversation pane stays above). Full overlays
replace the entire column (like today's menu screens). The component inside
handles its own rendering and keyboard; the overlay system just puts it on
screen and delivers the result when it dismisses.

## Why

The CLI had three separate mechanisms for asking the user something:

1. **Full-screen menus** — `setScreen('settings')` replaces the column with a
   Screen component. Keyboard ownership is implicit (the component's `useInput`
   fires because the chat is unmounted).

2. **Typed confirmations** — `/trash` and `/restart` set `promptTrashArmed` /
   `promptRestartArmed`, then the user types `c` into the message prompt. The
   submit path intercepts it. The user has no visible UI — just a note saying
   "type c to confirm."

3. **Slash menu** — ad-hoc JSX in App.tsx for autocomplete. Stays as-is
   (it's prompt autocomplete, not a dialog).

The overlay system replaces #1 and #2 with one concept. #3 stays unchanged.

## What was built

### Store (`window.ts`)
- `Overlay` interface: `{ size, name, component, onDismiss }`
- `overlay: Overlay | null` field on WindowStore
- `showOverlay(o)` — shows an overlay, auto-dismisses previous
- `dismissOverlay(result)` — clears field, fires callback (field cleared
  BEFORE callback so it can safely open another overlay)
- `hasOverlay` getter — the one gate for input routing

### Rendering (`App.tsx`)
- Full overlay (`size: 'full'`): renders between board and old menu dispatch,
  replacing the column
- Inline overlay (`size: 'inline'`): renders in the prompt zone, replacing
  the slash menu and prompt. The conversation pane stays above.
- Prompt hidden when an inline overlay is up
- App's main `useInput` gated on `!windowStore.hasOverlay`

### Confirm component (`components/Confirm.tsx`)
- Inline confirmation dialog: title, optional message, enter/esc
- Owns its own `useInput`

### Migrated commands
- `/trash` — was `promptTrashArmed` + typed `c` → now inline Confirm overlay
- `/restart` — was `promptRestartArmed` + typed `c` → now inline Confirm overlay

## What's left

### Remove old confirmation code
The `promptTrashArmed` and `promptRestartArmed` fields and their submit-path
interception in `submit()` still exist. They're used by the `/resume` picker's
`[t]` trash path (a different flow from the chat `/trash` command). Once that
path is also migrated, remove:
- `private promptTrashArmed` field
- `private promptRestartArmed` field
- The `if (this.promptTrashArmed)` block in `submit()`
- The `if (this.promptRestartArmed)` block in `submit()`
- The `trashActive` method's fallback to `promptTrashArmed` on unpushed_work

### Migrate full-screen menus to overlays
Each `setScreen('x')` call becomes a `showOverlay({ size: 'full', ... })`.
The component is the same — just wrapped in the overlay. `onClose` becomes
`() => windowStore.dismissOverlay(null)`.

Screens to migrate (in rough priority order):

| Screen | Command / trigger | Notes |
|--------|------------------|-------|
| `settings` | `/settings` | Simple: `setScreen` → `showOverlay` |
| `keys` | `/keys` | Same pattern |
| `secrets` | `/secrets` | Same pattern |
| `model` | `/model` | Same pattern |
| `server` | `/server` | Uses offline API — pass through |
| `voice` | `/assistant` | Same pattern |
| `presets` | `/presets` | Same pattern |
| `tasks` | `/tasks` | Has poll clock — start on show, stop on dismiss |
| `resume` | `/resume` | Has poll clock, pagination, trash arming |
| `workspace` | `/workspace` | Same as resume |
| `sessions` | ctrl+n | Instant show, async workspace fill |
| `addWorkspace` | from picker | Sub-screen of workspace |
| `workspaceSettings` | `[e]` on workspace | Sub-screen of workspace |
| `archived` | `/archived` | Pagination |
| `duplicateModel` | `/duplicate` | Already an inline-feeling screen |
| `board` | `/kanban` | Manages card editor internally |

For each migration:
1. Change the `setScreen('x')` call in `runCommand` (or wherever it opens) to
   `showOverlay({ size: 'full', name: 'x', component: ..., onDismiss: ... })`
2. Change the component's `onClose` prop from `windowStore.closeScreen` to
   `() => windowStore.dismissOverlay(null)`
3. For screens with poll clocks (resume, tasks): start the clock when the
   overlay opens, stop it on dismiss
4. Remove the screen's case from `screens.tsx` dispatch

Once all screens are migrated:
- Remove the `Menu` type union
- Remove `ScreenName` (replace with just `'chat' | 'board' | { card }`)
- Remove `setScreen` / `closeScreen` / `menuUp`
- Remove `screens.tsx` entirely
- Remove the old menu rendering path in App.tsx

### The board
The board + card editor is one full overlay. The Board component manages its
own sub-navigation (columns ↔ card editor) via the `card` prop. When migrated:
- `/kanban` opens a full overlay with the Board component
- The board's esc closes the overlay (`dismissOverlay(null)`)
- Card editing happens inside the board — no separate overlay needed
- `openCard` / `closeCard` become internal to the board's overlay

### Future: agent questions
The overlay system is ready for agent-triggered questions. The coding agent
would call `windowStore.showOverlay({ size: 'inline', ... })` with a Confirm,
a select list, or a text input. The dismiss callback returns the answer.
No new mechanism needed.
