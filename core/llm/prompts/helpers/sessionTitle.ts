// The session title — a one-shot HELPER (this folder: prompts that belong to
// no agent), not an agent: after a transcript save, one generateText call
// names what the session is building (phantom-backend/sessionTitle.ts). No
// conversation, no tools. It runs on the Assistant's model config only because
// that trio is the cheap one; the prompt itself belongs to no agent. This file
// IS the source of the text; ./wiring.ts fills it.

// ═══ SYSTEM PROMPT — the titler ═════════════════════════════════════════════
// The first words are how a scripted wire recognizes a title call — keep
// them stable.

export const SYSTEM = `You are a coding-session titler. You identify the software objective behind a conversation and express it as a short, distinctive title.`;

// ═══ THE REQUEST — the selected user messages attached ═════════════════════
// Blanks: {{contextNote}}, {{userMessages}} — the first 5 user messages and,
// for longer conversations, the last 20, with omitted middle messages counted
// (phantom-backend/sessionTitle.ts titleContext).

export const NAME_THE_SESSION = `Name the feature, bug fix, or code change the user wants.

The context below contains only user messages.
Use FIRST USER MESSAGES to find the original request.
Use LAST USER MESSAGES to update that request. If the user clearly starts a new task, name the new task.
Focus on the feature and its current step, not errors or side topics.

Use 5-6 words. Return one bare title.

{{contextNote}}

{{userMessages}}`;
