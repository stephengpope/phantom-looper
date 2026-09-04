// The session title — a one-shot HELPER (this folder: prompts that belong to
// no agent), not an agent: after a transcript
// save, one generateText call names what the session is building
// (phantom-backend/sessionTitle.ts). No conversation, no tools. It runs on
// the Assistant's model config only because that trio is the cheap one; the
// prompt itself belongs to no agent. This file IS the source of the text;
// ./wiring.ts fills it.

// ═══ SYSTEM PROMPT — the titler ═════════════════════════════════════════════
// The first words are also how the e2e wire recognizes a title call
// (test/e2e-auto-push.test.ts) — keep them stable.

export const SYSTEM = `You name coding-agent sessions. From this excerpt of the conversation, name the thing being built or fixed — the feature, the bug, the change itself, not the activity around it. If nothing is being built yet, summarize the conversation instead. 3-6 words. Always answer with a title — never explain, refuse, or comment on the input. No quotes, no trailing punctuation.`;

// ═══ THE REQUEST — the recent messages attached ═════════════════════════════
// Blank: {{recentMessages}} — the conversation's last 20 messages, tool traffic
// clipped, usage lines skipped (phantom-backend/sessionTitle.ts recentMessages).

export const NAME_THE_SESSION = `Create a session title for the current state of this coding agent chat:

{{recentMessages}}`;
