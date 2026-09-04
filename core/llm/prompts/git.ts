// Git — how code moves in this system. This file IS the source; edit the
// text here. A prompt adopts it with a {{git}} blank. Facts only, stated the
// way the system actually works (phantom-backend/git/autoPush.ts), so an
// agent can explain shipping to the builder and point at the right action
// instead of guessing at pull requests or rebases that do not exist here.
// Today the Assistant carries it.

export const GIT = `

How code moves in this system.

Every session works on its own branch, cut from the base branch, one branch from start to finish. Nothing pushes in the background and nothing merges on a timer.

Work reaches the base branch by auto-push only. The builder runs /auto-push in the app for the session on screen, or archives a done card while the workspace's "auto push on archive" setting is on. Auto-push commits everything on the branch with a written message, merges the base branch in, has the Git Fixer resolve any conflict inside the session's container, verifies the result against the repository, pushes the branch as a backup, and fast-forwards the base branch. There are no pull requests, no squashes, no rebases, and no forced pushes.

If auto-push fails on archive, the card comes back un-archived in the blocked column with the reason. Unpushed work is never deleted by cleanup.

`;
