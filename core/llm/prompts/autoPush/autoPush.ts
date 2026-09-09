// The sync's messages — the DOCUMENT: every word auto-push and auto-pull ever
// send, text only, zero logic. Filled by ./wiring.ts.
//
// ONE conflict message, because there is one operation. Auto-pull used to merge
// and needed its own "commit the merge" variant; it rebases now, so both finish
// the same way and the variant is gone.
//
// There is no system prompt here. Auto-push has no agent of its own: a stopped
// rebase is handed to the SESSION'S OWN coding agent, as one more message in
// the conversation that wrote the code. It already carries the card, the work
// and its own reasoning — the context a separate resolver would have to be
// told and, being a stranger, could only be told badly.

// ═══ CONFLICT → the session's coding agent · when a rebase stops ═══════════
// Blanks: {{branch}} the session branch, {{base}} the base branch,
// {{files}} the conflicted paths, {{arrived}} the commits that landed on base.
//
// A user message, not instructions in a system prompt: the coding prompt is
// frozen with its conversation, and this is guidance reaching a session that
// is already running.

export const RESOLVE_CONFLICT = `New commits landed on "{{base}}" that touch the same files you changed. A rebase was run to replay your work on top of them and a conflict needs to be resolved.

What landed on "{{base}}":
{{arrived}}

Conflicted files:
{{files}}

Read each conflicted file, keep both intents — yours and what arrived — and remove every conflict marker. Then stage the files and continue the rebase:

    git add <the files you fixed>
    git rebase --continue

Rules for this:
- Do NOT run \`git rebase --abort\`. Backing out is counted as a failure, not a resolution, and it throws away the landing.
- Do NOT run checkout, switch, branch, or reset --hard. The repository must stay on "{{branch}}".
- You have no network credentials here. Do not fetch, pull or push; those are done for you once the rebase is in.

Before you stop, check your own work — the system re-checks exactly this against the repo afterward, and any failure is named:
- \`git status\` is clean: nothing unstaged, nothing uncommitted.
- No conflict markers (<<<<<<<, =======, >>>>>>>) remain in any file.
- The rebase has finished: \`git status\` shows no rebase in progress (run \`git rebase --continue\` until it does not).
- origin/{{base}} is contained in your work: \`git merge-base --is-ancestor origin/{{base}} HEAD\` exits 0 (read-only, no network).
Stop only when all four pass. If you stop early, the replay is undone and the failed check is reported.

If the two sides genuinely cannot both be kept — what arrived and what you wrote contradict each other — do your best to reconcile them. If you cannot, stop and say which files and what the contradiction is.`;

// ═══ COMMIT MESSAGE REQUEST → the commit writer · every auto-push ══════════
// One generateText call on the ASSISTANT's model (git/commitMessage.ts), the
// squashed staged diff attached, with the card for intent: a diff says what
// changed and never why. The card line vanishes whole when there is no card —
// fill()'s rule for an optional line.

export const COMMIT_MESSAGE = `Write a git commit message for this change: one short imperative subject line (72 characters or less), optionally followed by a blank line and a brief body. Answer with the message only — no quotes, no preamble.

The work was done for this card: {{card}}

{{stat}}
{{diff}}`;
