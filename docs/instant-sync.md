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
| 2 | auto-push — only when a file changed and the files have then been quiet for the debounce | `instant_sync_push_debounce_ms` | 10 s |

The watcher does nothing but record when the last file changed. The beat
knows no git: it calls the two functions and logs a success; a refusal
(the checkout held by a manual sync, a rebase left for the agent) comes
back quietly and the next beat asks again. A push lands on the first beat
after the debounce: 10–15 s after the last edit. A push refused because the
checkout was held stays pending for the next beat.

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

## The checkout lock

A sync is a sequence of git commands; git's own `index.lock` guards one
command, not the sequence. Two syncs on one checkout interleave and wreck
the branch — and the session lock never prevented it: every sync took it
under one shared id, which the lock lets back in, and instant sync cannot
take it at all. So the lock sits on the checkout: `folders.sync_locked_by`
/ `sync_lock_expires_at` (038), owned by `Folders`, taken inside
`syncBranch` and `GitEngine.push` by **every** writer — instant, manual,
card archive, idle backup — under a fresh id per run, so it is never
re-entered. Manual sync takes it AND the session lock (no turn under the
sync); instant sync takes it alone. That is the whole difference between
them, said as locks.

## What is watched

Folders with a **running container**, in a workspace with the switch on.
Files only change through a container or through the sync itself. The
container tells instant sync as it happens: the watcher attaches inside the
container start, before the tool call that started it returns, and lets go
on removal. What no container event carries — the switch or a timing
changed (the settings bus says so), containers already running when the
server boots — runs one reconcile against the running containers. Never a
poll.

The watcher is `@parcel/watcher` (inotify). It ignores `.git` — every sync
would otherwise trigger itself. Anything else that changes fires, and
`hasWorkToLand` (`git status`) decides whether there is anything to push.

## Two fixes this forced on the shared sync

- **The backup push after a rewritten branch.** After the agent finishes a
  stopped rebase, origin holds the old copy of the branch and the next
  push's backup is rejected. `pushSession` used to fold origin's copy back
  in with a merge — re-creating the conflict and leaving the tree unmerged.
  One writer means origin is never newer, so a rejection means origin holds
  an older rewrite: it now forces with the lease. Proven on the exact state.
- **`GIT_EDITOR=true` in the workspace image.** `git rebase --continue`
  without a terminal errors "unable to start editor" (proven) — the agent
  could never finish a rebase, instant or manual.

## Known

- While a rebase is stopped in the checkout, no sync runs on it — instant
  or manual. Staging marker files would commit them as resolved.
- A container that dies on its own (not removed) keeps its watcher until a
  tool call recreates it; cost, one fetch per beat.

## What NOT to do

- Do not give instant sync its own git flow, commit message or resolver.
- Do not make it take the session. Waiting for a turn is the one thing it
  must never do.
- Do not add retries or back-off. A result is a result; the next change or
  the next interval is the next attempt.
- Do not add a busy flag or an in-process mutex here. The checkout lock is
  the one thing that keeps syncs apart, and it lives with the sync. A flag
  here once dropped pushes for a whole extra debounce.
- Do not watch every folder on disk.
