# phantom-backend/git/ — git the system runs

Every credential-bearing git call happens in this process, here. The
agent's container has no token unless `agent_git_credentials` is on.

```
git.ts            git(cwd, args, auth?) with the guard set; classifyGitFailure; cloneFresh; refreshPristine;
                  checkoutBranch; localState; workState; the primitives commitAll, pushSession, pushSessionForced,
                  pushToBase, fetchBase, stageAndSquash, commitStaged, rebaseOntoBase, rebaseInProgress,
                  rebaseAbort, verifyLanded, mergeBase (auto-pull's), initializeRemote
engine.ts         GitEngine: the manual push, pull and status behind /git/*
autoPush.ts       autoPush — the one way work reaches base; AUTOPUSH_CLIENT_ID, ConflictContext
autoPull.ts       autoPull — base into the session branch
commitMessage.ts  commitMessageFor — a model writes the subject from the squashed staged diff plus the card,
                  file names as the floor
github.ts         whoami, createRepo, listRepos on GitHub's REST paths (GITHUB_API_BASE is the test seam)
remote.ts         pure URL policy: remoteUrl, hasEmbeddedCredentials, parseGitHubUrl, parseRepoRef
```

## The guard set

`guards(auth)` resets the credential helper list, installs a helper for
github.com only that reads the token from env, pins `remote.origin.url`,
points hooks at `/dev/null`, and disables fsmonitor, sshCommand and
`ext::`. A token never lands in `.git/config`. `git()` re-throws with
git's stderr as the message so error text reaching people is git's own
words.

## Branch rules

One branch per session, `{prefix}/{id}`, cut from base at creation and
recorded on the folder row. `checkoutBranch` is the one place a branch is
chosen; a network failure there is an error, never "new branch".
`cloneFresh` uses `--depth=1` on the initial clone only, then a
best-effort `--shallow-since` fetch. Never `--depth` on a later fetch; it
regrafts the branch and inverts every ancestry check.

## Auto-push rebases

Take the session lock (failing to get it IS the busy test — nothing
inspects what is running), push the branch as the backup BEFORE anything
rewrites it, `add -A` and `reset --soft` to the merge base so the session
is one commit, write the message from that staged diff plus the card,
commit with a `Phantom-Session` trailer, `rebase origin/base`, hand a stop
to the coding agent, verify, force-push the branch with a lease, then a
plain fast-forward push to base. Base moved: rebase again, three rounds,
then give up with the branch intact.

Rebase, not merge: the landing is a plain commit rather than a merge
commit whose resolution normal review skips, and a rebase stands on base
instead of making "keep ours" mean "drop what arrived". The rule against
rewriting a published branch does not apply — one session owns its branch
and nothing else pulls it; the cost is the backup, which is why the backup
push comes first. `--force-with-lease` is used BARE, never
`=<ref>:<expected>`: bare implies `--force-if-includes`, which is what
closes the lease's real hole.

Squash first because replaying N commits stops N times, over intermediate
trees that never existed, re-resolving the same hunks. One commit stops at
most once, over finished work. It costs the step-by-step history on base.

## Auto-pull merges

Fetch and count first, so a no-op pull mints no commit. Commit the
session's work (never stash), merge base in, resolve, verify, push the
branch. Nothing lands on base, so there is no reason to rewrite the
branch. `merged` with `pushed: false` is still a sync. Auto-pull takes no
lock of its own — the resolver's `openSession` takes it. `docs/auto-pull.md`
is the plan for the rest.

## Resolving a conflict

The resolver is the SESSION'S OWN coding agent, as a turn in its own
transcript (wired in `index.ts`, run through `looper/turn.ts`). It is the
author: it already carries the card and its own reasoning, the resolution
is in the record rather than a side file, and it learns its files moved
under it. It holds no credentials — resolving is editing files; the fetch
before and the push after stay in this process. `ConflictContext` carries
the mode, the conflicted files and the commits that arrived on base; that
last one is the briefing a separate fixer never had.

`verifyLanded` is clean `status --porcelain`, no `--diff-filter=U`
entries, no rebase in flight, and origin/base an ancestor of HEAD. The
last two are what make an abort read as failure — a `rebase --abort`
leaves a clean tree with no markers. Never a grep for `=======`; it
matches Setext headings.

Auto-push aborts in exactly one place: when it gives up, so the session is
not left mid-rebase. The agent is told never to.

## Tested in

`test/unit.test.ts` (remote.ts, classifyGitFailure, localState, clone
depth), `test/phase3.test.ts` (manual push and pull), `test/phase4.test.ts`
(verifyLanded's four checks, the rebase primitives, stageAndSquash,
auto-push, auto-pull, GitHub against a fake), `test/e2e-auto-push.test.ts`.
