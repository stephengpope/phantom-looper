# phantom-backend/git/ — git the system runs

Every credential-bearing git call happens in this process, here. The
agent's container has no token unless `agent_git_credentials` is on.

```
git.ts            git(cwd, args, auth?) with the guard set; classifyGitFailure; cloneFresh; refreshPristine;
                  checkoutBranch; localState; workState; the primitives commitAll, pushSession, pushSessionForced,
                  pushToBase, fetchBase, hasWorkToLand, stageAndSquash, commitStaged, rebaseOntoBase, rebaseInProgress,
                  rebaseAbort, verifyLanded, initializeRemote, GIT_CLIENT_ID
engine.ts         GitEngine: the manual push, pull and status behind /git/*
sync.ts           syncBranch — THE flow, and the argument for it; ConflictContext, SyncEvent, the lock constants
autoPush.ts       autoPush — syncBranch with landOnBase: true. Result vocabulary only
autoPull.ts       autoPull — syncBranch with landOnBase: false. Result vocabulary only
commitMessage.ts  commitMessageFor — a model writes the subject from the squashed staged diff plus the card,
                  file names as the floor
github.ts         whoami, createRepo, listRepos on GitHub's REST paths (GITHUB_API_BASE points the client at another host)
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

## One flow

Auto-push, auto-pull and the manual `/git/pull` are the SAME operation asking
the same question — how do I get base's new commits under my work — so they
run one function, `syncBranch`. Auto-pull is auto-push without the last step.
`landOnBase` is the ONLY difference — one bit answering three questions:
whether to push to base, what "nothing to do" means, and whether rounds are
worth running.

Take the lock, fetch (what arrived on base is collected here and becomes the
conflict briefing), push the branch as the backup BEFORE anything rewrites it,
`add -A` and `reset --soft` to the merge base so the session is one commit,
write the message from that staged diff plus the card, commit with a
`Phantom-Session` trailer, `rebase origin/base`, hand a stop to the coding
agent, verify, force-push the branch with a lease — and then, only when
landing, a plain fast-forward push to base. Base moved: rebase again, three
rounds, then give up with the branch intact.

"Is there anything to do" is asked once, before anything is written, so an
idle run mints no commit and spends no model call: a push has nothing to do
when the session has no work (`hasWorkToLand`), a pull when base has not moved
— the same question read from each direction. Rounds are the landing's:
nothing races a pull, so a sync that does not land runs one round.

Rebase, not merge: the landing is a plain commit rather than a merge commit
whose resolution normal review skips, and a rebase stands on base instead of
making "keep ours" mean "drop what arrived". This holds for a PULL too — a bad
resolution sits on the branch and the next auto-push squashes and lands it, so
"a pull lands nothing" is false. The rule against rewriting a published branch
does not apply: one session owns its branch and nothing else pulls it; the
cost is the backup, which is why the backup push comes first.
`--force-with-lease` is used BARE, never `=<ref>:<expected>`: bare implies
`--force-if-includes`, which is what closes the lease's real hole.

Squash first because replaying N commits stops N times, over intermediate
trees that never existed, re-resolving the same hunks. One commit stops at
most once, over finished work. It costs the step-by-step history on base, and
it means a BLOCKED sync leaves the branch collapsed locally — same content,
rewritten commit; the pre-squash commit is on origin as the backup.

## The lock

`GIT_CLIENT_ID` is the one id auto-push, auto-pull and the manual
`/git/pull` hold the session under, renewed on a beat for as long as they
run. Failing to take it IS the busy test — nothing inspects what is
running. One id, because the conflict turn opens the session from inside
an operation that already holds the lock and `acquireLock` only lets a
holder re-take its OWN hold; the per-call label says which operation it
is. `engine.push` still takes none.

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

