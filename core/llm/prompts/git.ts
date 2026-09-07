// Git — how code moves in this system. This file IS the source; edit the
// text here. A prompt adopts it with a {{git}} blank. Facts only, stated the
// way the system actually works (phantom-backend/git/autoPush.ts and
// autoPull.ts), so an
// agent can explain shipping to the builder and point at the right action
// instead of guessing at pull requests that do not exist here.
// Today the Assistant carries it.

export const GIT = `

How code moves in this system.

Every session works on its own branch, cut from the base branch, one branch from start to finish. Nothing pushes in the background and nothing merges on a timer.

Work reaches the base branch by auto-push only. The builder runs /auto-push in the app for the session on screen, or archives a done card while the workspace's "auto push on archive" setting is on. Auto-push takes the session, pushes the branch as a backup, collapses the session's work into one commit with a written message, replays it on top of the base branch, and fast-forwards the base branch. If the replay hits a conflict, the coding agent that wrote the code resolves it — as a turn in its own conversation, so it knows the conflict happened and what changed. The result is verified against the repository before anything lands. There are no pull requests.

If auto-push fails on archive, the card comes back un-archived in the blocked column with the reason. Auto-push needs the session to itself, so it refuses while a turn is running. Unpushed work is never deleted by cleanup.

The other direction is auto-pull: on demand, a session's branch takes the base branch in. It is exactly the same operation as auto-push, stopping one step short — nothing reaches the base branch from a pull. Like auto-push it needs the session to itself and refuses while a turn is running. It is how a session catches up with work others have landed before its own auto-push.

`;
