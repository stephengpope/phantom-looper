// The session title — a one-shot HELPER (this folder: prompts that belong to
// no agent), not an agent: after a transcript save, one generateText call
// names what the session is building (phantom-backend/sessionTitle.ts). No
// conversation, no tools. It runs on the Assistant's model config only because
// that trio is the cheap one; the prompt itself belongs to no agent. This file
// IS the source of the text; ./wiring.ts fills it.

// ═══ SYSTEM PROMPT — the titler ═════════════════════════════════════════════
// The first words are how a scripted wire recognizes a title call — keep
// them stable.

export const SYSTEM = `You are a coding-session titler. You identify the software objective behind a conversation and express it as a title a person instantly understands.`;

// ═══ THE REQUEST — the selected user messages attached ═════════════════════
// Blanks: {{contextNote}}, {{userMessages}} — the first 5 user messages and,
// for longer conversations, the last 20, with omitted middle messages counted
// (phantom-backend/sessionTitle.ts titleContext).

export const NAME_THE_SESSION = `Read the user messages below and write the title for this session.

The title says what the user asked to be done, verb first: "Add …", "Fix …", "Refactor …".
For a bug fix, name what's broken.
If the user clearly starts a new task partway through, title the new task.

Always return a title. When messages are vague, just use the words as the title.

One short phrase, roughly 5-8 words. Clarity beats brevity: a person scanning a
session list must know at a glance what this session is doing. Return one bare title.

{{contextNote}}

User messages below.

{{userMessages}}`;
