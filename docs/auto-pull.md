# auto-pull — the plan

Auto-push now rebases. Auto-pull was deliberately left merging. This is
what still has to change and why, written from what the swap actually
turned up.

## Where it stands

Auto-pull today: fetch and count, commit the session's in-flight work,
`mergeBase` (merge `origin/<base>` into the branch), hand a conflict to the
resolver, verify with `verifyLanded`, push the branch as the backup.
Nothing lands on base.

Two things changed under it during the auto-push swap, and both are live:

- **The resolver is the coding agent.** The Git Fixer is gone. A conflicted
  pull now opens a turn in the session's own transcript with `mode: 'merge'`,
  which tells the agent to finish with `git commit --no-edit` rather than
  `git rebase --continue`.
- **Verification is `verifyLanded`**, which adds a rebase-in-flight check to
  the old three. Harmless for a merge, and correct if auto-pull ever replays.

`mergeBase` in `git.ts` exists for auto-pull and the manual `/git/pull` and
nothing else.

## The one real problem: auto-pull takes no lock

Auto-push takes the session lock and fails when it cannot get it — the lock
IS its concurrency test. Auto-pull takes nothing. It merges into a checkout
that a coding turn may be writing at the same moment.

Today that is *partly* covered by accident: when a pull conflicts, the
resolver calls `openSession(..., lock: true)`, which throws
`SessionLockedError` if a turn holds the session, and the pull blocks. But
that only fires on the conflict path. A **clean** pull merges, commits and
pushes with no lock at all, underneath a running turn.

**The fix is the same shape as auto-push's.** Take the lock at the top under
`AUTOPUSH_CLIENT_ID` (the resolver re-takes its own hold, so nothing
deadlocks), renew it on a beat, release in `finally`, and add `busy` to
`AutoPullResult`. That is the whole change and it should happen before
anything else here.

Two callers have to learn `busy`: the `/git/auto-pull` route's result union
and the Assistant's `git_auto_pull` tool wording.

## Should auto-pull rebase too?

Probably not, and the reasoning is worth keeping.

The case for rebase in auto-push is that the landing becomes a plain commit
on base rather than a merge commit whose resolution normal review skips.
Auto-pull lands nothing on base, so that argument does not apply to it. What
it would buy is a linear session branch; what it would cost is rewriting the
branch on every catch-up, which means force-pushing the backup repeatedly
and losing the property that the branch is append-only between landings.

There is a second-order argument for it: auto-push squashes and rebases at
landing time anyway, so any merge commits auto-pull made get collapsed then.
That makes auto-pull's merges cosmetic and short-lived — which is a reason
not to bother rewriting them, not a reason to.

**Recommendation: leave auto-pull merging.** If it ever changes, the
primitives are already there (`fetchBase`, `stageAndSquash`,
`rebaseOntoBase`, `rebaseAbort`) and the prompt already carries a rebase
mode.

## Smaller things the swap exposed

- **No rounds, and that is still right.** Nothing races a pull; base moving
  after the merge is simply the next pull.
- **`arrived` is now used.** It was computed and thrown away before. Auto-pull
  passes it into `ConflictContext`, so the agent is told what landed on base.
  Keep that if the flow is ever rewritten.
- **The manual `/git/pull` in `GitEngine`** shares the resolver and the same
  `mode: 'merge'`. It also takes no lock. Same fix, same reason — it is the
  smaller sibling of the auto-pull problem, not a separate one.
- **`commitAll` in `git.ts`** is now only used by `GitEngine`. Auto-push uses
  `stageAndSquash` + `commitStaged`. Worth collapsing if `GitEngine` is ever
  reworked.

## What NOT to do

- Do not add a second lock or an operation mutex. The session lock is the
  only one; auto-pull should take that one, not invent another.
- Do not make auto-pull spin up its own resolver agent. One conversation per
  session is the point; the coding agent resolving its own conflicts is the
  whole reason the Git Fixer was deleted.
- Do not verify by grepping for conflict markers. `verifyLanded` asks the
  repository.
