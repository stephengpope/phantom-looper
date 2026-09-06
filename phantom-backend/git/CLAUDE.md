# phantom-backend/git/ — git the system runs

Every credential-bearing git call happens in this process, here. The
agent's container has no token unless `agent_git_credentials` is on.

```
git.ts            git(cwd, args, auth?) with the guard set; classifyGitFailure; cloneFresh; refreshPristine;
                  checkoutBranch; localState; workState; the primitives commitAll, pushSession, pushToBase,
                  mergeBase, initializeRemote
engine.ts         GitEngine: the manual push, pull and status behind /git/*
autoPush.ts       autoPush — the one way work reaches base
autoPull.ts       autoPull — base into the session branch
gitFixer.ts       runGitFixer, verifyResolved, AiSdkGitFixerDriver (the core Git Fixer agent over a container exec)
commitMessage.ts  commitMessageFor — a model writes the subject from the staged diff, file names as the floor
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
regrafts the branch and inverts every ancestry check. Merge, never
rebase. No push is ever forced.

## Auto-push

Commit everything with a model-written message and a `Phantom-Session`
trailer, merge origin/base in, hand a conflict to the Git Fixer, verify,
push the branch as the backup, then a plain fast-forward push to base.
If base moved, merge again, three rounds, then give up with the branch
intact. Not a squash: a squash makes every later auto-push a false
self-conflict.

## Auto-pull

Fetch and count first, so a no-op pull mints no commit. Commit the
session's work (never stash), merge base in, fix, verify, push the
branch. Nothing lands on base. `merged` with `pushed: false` is still a
sync.

## The Git Fixer

Holds no credentials; its `bash` runs in the workspace container. Bounded
by attempts and the agent's `maxSteps`, never by a clock. Each attempt
continues on the same directory. `verifyResolved` is clean
`status --porcelain`, no `--diff-filter=U` entries, and origin/base an
ancestor of HEAD. The last check is what makes a `merge --abort` read as
failure. Never a grep for `=======`.

The fixer's model trio cascades to the coding agent's (`git_fixer_*`);
the commit-message model is the same config and degrades to file names
when it cannot build.

## Tested in

`test/unit.test.ts` (remote.ts, classifyGitFailure, localState, clone
depth), `test/phase3.test.ts` (manual push and pull), `test/phase4.test.ts`
(auto-push, auto-pull, the fixer, GitHub against a fake), `test/e2e-auto-push.test.ts`.
