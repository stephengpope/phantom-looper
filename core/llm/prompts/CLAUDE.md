# core/llm/prompts/ — the prompt documents

A prompt is a **document** (a `.ts` file of template strings, text only,
blanks written `{{name}}`) plus a `wiring.ts` beside it that fills the
blanks. `template.ts` is the whole mechanism. No prompt text lives in
wiring, and no code lives in a document.

```
template.ts            fill(template, vars) · firstLineOf(template, vars) · withCurrentDate(instructions)
stakeholders.ts        STAKEHOLDERS — who is who            } shared blocks, filled into the
values.ts              VALUES — the six values              } documents that name them
communication.ts       COMMUNICATION — the written register  }
environment.ts         ENVIRONMENT — the container line ({{facts}})
git.ts                 GIT — how code moves (branch per session, auto-push, auto-pull, no PRs)
sending.ts             SENDING_FILES — deliver a file by naming its path (the MEDIA: form)
coding/                SYSTEM, SKILLS, SECRETS, CREDENTIALS_FACT · wiring: systemPrompt(skills, git, secrets, facts)
assistant/             SYSTEM · wiring: systemPrompt()
supervisor/            SYSTEM + every message the looper sends (below) · wiring: firstLine, toCodingAgent, toSupervisor
gitFixer/              SYSTEM, FIRST_MESSAGE_RECOVER, COMMIT_MESSAGE · wiring: systemPrompt, toGitFixer, commitMessagePrompt
helpers/               sessionTitle.ts — the auto-titler's one-shot pair, not an agent · wiring: titleRequest
```

Which document uses which block: coding takes stakeholders, values,
communication, environment, sending. Supervisor takes stakeholders, values,
communication. Assistant takes stakeholders, values, git, sending (spoken
register, so no communication block). Git Fixer takes none.

## fill()

- A blank with no value throws, so a document and its wiring must agree.
- A line whose blanks all resolve empty vanishes whole. That is how an
  optional line is written: put it in the document with its label, and it
  is absent when its value is.
- Values go in last and are never re-scanned, so JSON and diffs are safe.
- Edges are trimmed once (template and values), so documents may open and
  close on blank lines. Spacing inside a value is verbatim.

## Frozen

A prompt is assembled once when its conversation begins and stays with it:
the coding prompt in the transcript header, the Assistant's for the sidecar's
life, a Git Fixer run is one conversation. Editing a document changes new
conversations only. Anything that must reach a running session goes in a
tool's description instead. The date is not in the frozen text;
`withCurrentDate` appends it at every agent build.

## The supervisor document is the loop's script

Every fixed message the looper sends is a constant here. The model never
authors one. Who gets what:

| constant | goes to | when |
|---|---|---|
| `PLAN_CARD` | coder, first message | card enters `plan` |
| `BUILD_FROM_PLAN` | coder | `in_progress` after a plan phase in this session |
| `BUILD_FROM_CARD` | coder, first message | `in_progress` with no plan phase |
| `IMPLANTED_REVIEWING_PLAN` | supervisor transcript, user role | before the first copied plan reply |
| `IMPLANTED_REVIEWING_WORK` | supervisor transcript, user role | before the first copied build reply |
| `CARD_IS_BACK` | coder | a person moved the card back from blocked or done |
| `PLAN_FORMAT`, `REPORT_FORMAT` | both sides | filled into the kickoff and the matching briefing |

`SYSTEM` holds only what is true in every phase. Everything phase-specific
rides the implanted briefing. `toSupervisor.reviewingWork(card, {planned})`
decides from loop state whether the card rides along and which contract
line is used; the model never infers the phase.

`firstLine.*` is the first line `fill` would send for each message. The
looper matches these against transcripts to know what was already sent, so
a reworded body never breaks the match. `BUILD_FROM_CARD` must contain no
planning language; the discriminator depends on it.

## Tested in

`test/llm.test.ts` (fill's rules, the prompt stack, every loop message
starts with its own first line and the lines are unique).
