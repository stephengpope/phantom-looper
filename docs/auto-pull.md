# auto-pull

Auto-pull is auto-push without the last step. Both run one function: `syncBranch` in the backend SDK (`git/sync.ts`).

## Why they were folded together

They are the same operation asking the same question — *how do I get base's
new commits under my work* — and for one commit they had two answers.

Auto-pull merged. The reason given was: "a pull lands nothing on base, so a
resolution buried in a merge commit does not matter." **That is false.** The
resolution sits on the branch, and the next auto-push squashes the branch into
one commit and lands it. The damage reaches base either way, just laundered
through the squash instead of through the merge commit.

The second reason given was that rebasing on pull means force-pushing the
backup on every catch-up. Also empty: auto-push already force-pushes the
branch at every landing, so the append-only property being protected was
already gone.

Nothing survived. One operation, one answer.

## The difference, in full

```
syncBranch(deps, session, project, { landOnBase, label })
```

`landOnBase` is the whole difference. One bit, three consequences:

- **The fast-forward push to base** happens only when landing.
- **"Nothing to do" reads from the matching direction.** A push has nothing to
  do when the session has no work (`hasWorkToLand`); a pull has nothing to do
  when base has not moved. Asked once, before anything is written, so an idle
  run mints no commit and spends no model call.
- **Rounds** — three when landing, one otherwise. Base can move between the
  rebase and the fast-forward; nothing races a pull, because base moving after
  it is simply the next pull.

There was briefly a second knob, `onlyWhenBaseMoved`. Every caller passed it
as the exact inverse of `landOnBase` — two names for one bit — so it is gone.

Everything else is shared: the lock, the backup push, the squash, the commit
message, the replay, the conflict handoff, the verification, the forced branch
push.

## What this deleted

- `mergeBase` in `git.ts`
- `RESOLVE_MERGE_CONFLICT` and the `ConflictMode` split — one conflict message,
  because there is one operation
- ~190 lines of duplicated flow in `autoPull.ts`, now a result mapping
- the merge path in `GitSync.pull`, now a result mapping

## One consequence worth knowing

A **blocked** sync leaves the branch collapsed to one commit locally. The
squash happens before the replay, so a conflict that the agent cannot resolve
leaves the same content under a rewritten commit. The pre-squash commit is on
origin — the backup push runs before anything is rewritten; trees, not shas,
are what agree after a rewrite.

## Push and backup

`GitSync.push` and `backup` commit and push the branch, nothing more. Both
take the checkout lock (038), so neither interleaves with a sync.

`push` takes no session lock on purpose: its callers own it. Duplicate
already holds the session under `GIT_CLIENT_ID` when it flushes (a hold
taken inside push would be released under it, mid-copy). Delete flushes
before it destroys, and must flush even while a window holds the session —
a `busy` there loses the work. `backup` is the one caller with no hold of
its own (the disk sweeps), so it takes the session itself.

## The conflict turn keeps the session's driver

The conflict turn runs under `GIT_CLIENT_ID`. Its turn-end records no
`last_turn_by`: a card run's or a cron's session stays theirs, not a
person's.

## What NOT to do

- Do not add an in-process mutex. Two locks, each on the thing it guards: the
  session lock (held under `GIT_CLIENT_ID` by every git operation so the
  conflict turn can re-take its own hold) keeps a turn and a sync apart; the
  checkout lock on the workspace (038, fresh id per run, never re-entered) keeps
  two syncs apart — see instant-sync.md.
- Do not give the pull its own resolver agent. One conversation per session is
  the point.
- Do not verify by grepping for conflict markers. `verifyLanded` asks the
  repository: clean tree, no unmerged entries, no rebase in flight, and
  origin/base in HEAD's history.
