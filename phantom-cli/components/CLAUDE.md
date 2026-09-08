# phantom-cli/components/ — the screens and the pieces they share

```
Text.tsx            THE Text. Expands tabs to 8-column stops and drops control characters before Ink measures.
                    Nothing imports Ink's Text directly
Boundary.tsx        the error boundary: stack to console.error (cli.log), message to onError, draws nothing until resetKey changes
Screen.tsx          the page frame every menu renders in: title, one always-rendered status line (error > notice > busy > sub),
                    the key footer via keyLine, the row budget (BudgetContext from SizeContext)
SelectList.tsx      the list: window sized from the budget, a fixed HINT_ROWS hint block, columns, markers (busy/dot/lock),
                    onKey shortcuts, onNearEnd for lazy pages, `pad` to hold one height, `initial` for the returning cursor
table.ts            tableChoices — column geometry for a SelectList page; the header is a heading Choice with columns
TextInput.tsx       the single-line editor. A key is text only if it looks like text; ctrl/meta and named keys fall through
ValueInput.tsx      one value: a picker for choices, a combobox (SuggestField) for suggestions, a text line otherwise
Pane.tsx            the bottom-anchored viewport: a virtual list that measures each item and remembers heights by key
Parts.tsx           PartView, one component per Part kind; clipRows (row budgets), summarizeInput / summarizeOutput
Markdown.tsx        marked + marked-terminal with two renderer patches (inline children in tight lists, ordered `start`)
Shimmer.tsx         Shimmer (continuous), Glint (occasional), GlintRows (over block art)
Banner.tsx          the launch splash: the ghost and the infinity mark, drawn as the Pane's fill
Prompt.tsx          the typing area between two rules; the bottom rule carries the version label
Toolbar.tsx         the line under the prompt: the notice, and the spinner for a session held elsewhere
StatusLine.tsx      "⠹ Working… (44s · ↓ 1.7k tokens · thinking) · [esc] to interrupt"
Divider.tsx         the vertical rule between the panes, with junctions where the prompt's rules meet it
Board.tsx           /kanban: columns from the BoardStore, keys and mouse drag, the archive arm. Which card's
                    editor is open is the WINDOW's (`card` + onOpenCard/onCloseCard), not the board's, because
                    the window also knows where esc leaves it
CardEditor.tsx      the card page: every field, one live TextInput on the focused row, debounced auto-save,
                    letter quick actions (a/s/p/b) on the non-text rows only;
                    the Status row under the title cycles the card's column through store.move
Archived.tsx        /archived: a table of archived cards, restore and open
Tasks.tsx           /tasks: live process groups and recent commands, kill by sid
Launcher.tsx        /resume and /workspace: SessionInfo, whoDrives, isRunning, ago, lastWorkspaceId, the session table
SessionSwitcher.tsx ctrl+n: the sessions open in this window
NewWorkspace.tsx    add a workspace: pick from GET /github/repos, or type a URL, or create on GitHub
Settings.tsx        /settings, /model, /server, /voice: local rows and server rows, one writer per home;
                    providerChoices, providerForModelRow, buildModelSpec, MODEL_ROWS, MODEL_FOR_PROVIDER
Presets.tsx          /presets: saved provider configurations; list → apply/edit/new/delete; the editor is the
                    11 model keys in a SelectList + ValueInput, same pattern as /model
WorkspaceSettings.tsx  `e` on /workspace: the row plus every overridable setting from GET /workspaces/:id
Keys.tsx            /keys: the server's credentials, one row each, github_token checked on save
Secrets.tsx         /secrets: every layer in one list; SecretEditor for new and edit
SecretEditor.tsx    a card-style popup that never auto-saves; esc kills it
VoicePanel.tsx      the Assistant's pane: status, switch rows, the chat in a Pane, the approval block
```

## Rules the pieces enforce

- A browse screen is `Screen` + `SelectList`, in the shape /resume has.
  Nothing hand-rolls a pane or a footer.
- A gutter is `paddingRight` inside a fixed `flexShrink={0}` box, never
  leftover space. When a row overflows, yoga squeezes shrinkable boxes
  first, so an unpinned gutter vanishes. A table header goes through the
  same boxes as its rows.
- Every region holds one height while on screen. The hint block is exactly
  `HINT_ROWS`; the slash menu renders every slot; `pad` keeps a filtering
  list tall. A region that grows and shrinks rewrites every shifted row.
- Cursors live in refs and are read from refs. Two keypresses batched into
  one React update would both see a stale closure otherwise. SelectList,
  TextInput, CardEditor and SecretEditor all follow this.
- `SelectList` ignores `key.ctrl` and `key.meta` before `onKey`, because
  Ink reports ctrl+c as the letter c. Any handler that inserts text checks
  `isMouseInput` first, because a mouse report reaches every handler as
  plain text.
- Every settings screen remembers the row it opened (`initial`) so the
  list returns to the setting just changed.
- Key hints are bracketed and name their subject. Status indicators show
  state at all times, never only when non-zero.

## Pane

Content sits in one wrapper Box; scrolling up is a negative bottom margin;
a pane with no height draws nothing. Only items near the view are laid
out. Heights are remembered by `keyFor`, so a reseat keeps its
measurements. A caller must not move its scroll in reaction to
`onMeasure`.

## Tool rows

A tool row is budgeted in rendered rows, not lines: the command keeps its
head, the output its tail, each cut marked with the ctrl+o hint. A result
that is not a log is one line (`42 lines`, `7 matches`, `2KB written`).

## Tested in

`components/*.test.tsx` and `menus.test.tsx`. `Text.test.tsx` scans the
tree for direct Ink Text imports.
