# auto-pull

Auto-pull is auto-push without the last step. Both, and the manual
`/git/pull`, run one function: `syncBranch` in `phantom-backend/git/sync.ts`.

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
syncBranch(deps, session, workspace, { landOnBase, label, onlyWhenBaseMoved })
```

- **`landOnBase`** — the fast-forward push to base. True for auto-push, false
  for auto-pull and the manual pull.
- **`onlyWhenBaseMoved`** — the pull's early exit. Nothing behind means nothing
  to do, asked before anything is written, so a no-op pull mints no commit and
  spends no model call. A push has to proceed on local work whether or not
  base moved.
- **Rounds** — three when landing, one otherwise. Base can move between the
  rebase and the fast-forward; nothing races a pull, because base moving after
  it is simply the next pull.

Everything else is shared: the lock, the backup push, the squash, the commit
message, the replay, the conflict handoff, the verification, the forced branch
push.

## What this deleted

- `mergeBase` in `git.ts`
- `RESOLVE_MERGE_CONFLICT` and the `ConflictMode` split — one conflict message,
  because there is one operation
- ~190 lines of duplicated flow in `autoPull.ts`, now a result mapping
- the merge path in `GitEngine.pull`, now a result mapping

## One consequence worth knowing

A **blocked** sync leaves the branch collapsed to one commit locally. The
squash happens before the replay, so a conflict that the agent cannot resolve
leaves the same content under a rewritten commit. The pre-squash commit is on
origin — the backup push runs before anything is rewritten. `test/phase3.test.ts`
compares trees rather than shas for exactly this reason.

## Still open

- **`engine.push` takes no lock.** It runs `commitAll` and pushes the branch,
  so under a running turn it commits a half-written tree. It only ever adds a
  commit to the branch and never merges or rewrites, which is why it is smaller
  than the pull hole was — but it is the same shape and the same fix.
- **A git-driven turn is attributed to nobody.** `agentAfterSave` maps the
  writer's client id to `coding` only for `LOOP_CLIENT_ID`; a conflict turn
  writes under `GIT_CLIENT_ID`, so the session's `agent` column comes back
  null, which reads as "a person's". Cosmetic, wrong, cheap to fix.
- **`commitAll`** is now only used by `GitEngine.push`. Worth collapsing if
  that is ever reworked.
- **`PullResult`'s `dirty_tree` and `diverged`** are no longer reachable — the
  sync commits everything, and a rebase either starts or errors. The union is
  still what the app reads.

## What NOT to do

- Do not add a second lock or an operation mutex. The session lock is the only
  one in the system, held under `GIT_CLIENT_ID` by every git operation so the
  conflict turn can re-take its own hold.
- Do not give the pull its own resolver agent. One conversation per session is
  the point.
- Do not verify by grepping for conflict markers. `verifyLanded` asks the
  repository: clean tree, no unmerged entries, no rebase in flight, and
  origin/base in HEAD's history.
