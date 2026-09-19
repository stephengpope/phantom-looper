# instant sync

Auto-push and auto-pull, fired for you. A workspace switch (`instant_sync`,
off by default) that keeps every running session's checkout in step with the
base branch without anyone running `/auto-push` or `/auto-pull`. Built for a
notes or second-brain repo shared across devices.

One file decides WHEN: `phantom-backend/git/instantSync.ts`. HOW is the
same `autoPush` / `autoPull` everything else calls (see auto-pull.md) —
same backup, squash, commit message, rebase, verify, push.

## The beat

One beat per checkout, every pull interval, in order:

| step | what | setting | default |
|---|---|---|---|
| 1 | auto-pull — its first step is a plain `git fetch` of base; nothing new and it stops there | `instant_sync_pull_interval_ms` | 5 s |
| 2 | auto-push — only when a file changed and the files have then been quiet for the debounce | `instant_sync_push_debounce_ms` | 30 s |

The watcher does nothing but record when the last file changed. Step 2
waits for step 1; the next beat waits for step 2 — one timer, so nothing
overlaps and no flag or second lock is needed. A push lands on the first
beat after the debounce: 30–35 s after the last edit.

The switch is workspace-only (`/workspace` → `e`). The debounce and the
interval are global settings (`/settings`) a workspace may override; empty
on the workspace means it follows the global value.

The fetch is git, never the GitHub API — it costs no rate limit.

## Instant means now

An instant sync runs turn or no turn. Two things are set differently from
a manual sync, both in `index.ts`:

- **It does not take the session** (`hold: false` on the sync). A
  30-minute turn never holds a push back. A push can therefore fire while
  the agent is mid-edit; a half-written file can reach base for a few
  seconds, until the next push.
- **It never runs the conflict fixer** (no `resolve`). The fixer is a turn
  in the session, and the session may be mid-turn. The rebase is left
  stopped, markers in the files, nothing lands.

## What the agent is told

A manual sync writes its note into the transcript under the session lock.
An instant sync has no lock, so its notes ride the backdoor queue
(`api/backdoor.ts`) — the same queue detached commands use — and land in
front of the agent's next turn wherever that turn runs (server, cli,
Telegram). A note already waiting is not queued again.

- pushed / pulled: the existing note.
- conflict: what came in, then the conflicting files, then
  "Resolve the conflict." The agent resolves in place, `git add`,
  `git rebase --continue`; the next file change pushes.

The queue is in memory: a server restart drops a waiting note. The repo
still holds the state.

## What is watched

Folders with a **running container**, in a workspace with the switch on.
Files only change through a container or through the sync itself. The set
is reconciled every ten seconds on the work-state loop in `index.ts`.

The watcher is `@parcel/watcher` (inotify). It ignores `.git` — every sync
would otherwise trigger itself. Anything else that changes fires, and
`hasWorkToLand` (`git status`) decides whether there is anything to push.

## Known

- A manual `/auto-push` and an instant sync can run on one checkout at the
  same time. The session lock does not stop it (instant sync does not take
  it, and every sync takes it under one name that re-enters). Left as is.
- While a rebase is stopped in the checkout, no sync runs on it — instant
  or manual. Staging marker files would commit them as resolved.

## What NOT to do

- Do not give instant sync its own git flow, commit message or resolver.
- Do not make it take the session. Waiting for a turn is the one thing it
  must never do.
- Do not add retries or back-off. A result is a result; the next change or
  the next interval is the next attempt.
- Do not add a second lock or a busy flag. One timer per checkout is what
  keeps push and pull apart; a flag here once dropped pushes for a whole
  extra debounce.
- Do not watch every folder on disk.
