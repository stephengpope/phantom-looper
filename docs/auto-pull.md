# auto-pull

Auto-push rebases. Auto-pull merges, on purpose. This records why, and what
was fixed when the two were reconciled.

## What auto-pull does

Take the session lock, fetch and count (a no-op pull mints no commit and
spends no model call), commit the session's in-flight work, merge
`origin/<base>` into the branch, hand a conflict to the session's own coding
agent, verify with `verifyLanded`, push the branch as the backup. Nothing
lands on base.

## Fixed: it took no lock

This was the real problem and it is done.

Auto-push takes the session lock and fails when it cannot — the lock IS the
concurrency test. Auto-pull took nothing, so it committed the working tree
and merged into a checkout that a coding turn might be writing at that exact
moment.

A conflicted pull was *accidentally* half-covered: the resolver calls
`openSession(..., lock: true)`, which throws if a turn holds the session. But
that only fired on the conflict path. A **clean** pull merged, committed and
pushed with no lock at all, underneath a running turn.

Now auto-pull acquires the lock first under `GIT_CLIENT_ID`, renews it on a
beat (a conflict turn outlives any fixed TTL), releases it in a `finally`,
and returns `busy` when someone else holds it. `AutoPullResult` carries
`busy`; the route's union and the Assistant's tool wording already did.

The manual `/git/pull` had the same hole and got the same fix —
`GitEngine.pull` locks and returns `'busy'`, with the work moved into a
private `pullLocked`.

One id for every git operation, deliberately: the conflict turn opens the
session from *inside* an operation that already holds the lock, and
`acquireLock` only lets a holder re-take its own hold. The per-call label
(`auto-push`, `auto-pull`, `pull`) is what tells a person which one is
holding it.

## Why it stays a merge

The case for rebase in auto-push is that the landing becomes a plain commit
on base rather than a merge commit whose resolution normal review skips.
**Auto-pull lands nothing on base, so that argument does not apply to it.**

What rebase would buy is a linear session branch. What it would cost is
rewriting the branch on every catch-up — force-pushing the backup
repeatedly, and losing the property that the branch is append-only between
landings.

There is a second-order argument for it: auto-push squashes and rebases at
landing time anyway, so whatever merge commits auto-pull made get collapsed
then. That makes auto-pull's merges cosmetic and short-lived — a reason not
to bother rewriting them, not a reason to.

If that ever changes, the primitives exist (`fetchBase`, `stageAndSquash`,
`rebaseOntoBase`, `rebaseAbort`) and the conflict prompt already carries a
rebase mode.

## Still open

- **`engine.push` takes no lock.** It runs `commitAll` and pushes the branch,
  so under a running turn it commits a half-written tree. Smaller than the
  pull hole was — it only ever adds a commit to an append-only branch, and
  never merges or rewrites — but it is the same shape and the same fix.
- **A git-driven turn is attributed to nobody.** `agentAfterSave` maps the
  writer's client id to `coding` only for `LOOP_CLIENT_ID`; a conflict turn
  writes under `GIT_CLIENT_ID`, so the session's `agent` column comes back
  null, which reads as "a person's". Cosmetic, wrong, cheap to fix.
- **`commitAll`** is now only used by `GitEngine`; auto-push uses
  `stageAndSquash` + `commitStaged`. Worth collapsing if `GitEngine` is
  reworked.
- **No rounds, and that is still right.** Nothing races a pull; base moving
  after the merge is simply the next pull.

## What NOT to do

- Do not add a second lock or an operation mutex. The session lock is the
  only one in the system.
- Do not give auto-pull its own resolver agent. One conversation per session
  is the point — the coding agent resolving its own conflicts is why the Git
  Fixer was deleted.
- Do not verify by grepping for conflict markers. `verifyLanded` asks the
  repository: clean tree, no unmerged entries, no rebase in flight, and
  origin/base in HEAD's history.
