// The system prompt: built ONCE when a session is created, written to the
// session with its row, never changed. Every turn sends it as stored.
//
// Who builds what: the agent declares its LAYOUT — three sections, each an
// ordered list of entries. An entry is either the agent's own text
// (`agentText`) or the NAME of a block only the server can fill (the repo's
// SOUL.md, the skills list, today's date…). The server fills the named
// blocks, keeps the text as is, drops what came out empty, and stores the
// three sections. The three are three system messages, one cache mark each.
//
//   stable   — the same on every session: identity, the agent's instructions
//   context  — the same on one repo: AGENTS.md, environment, git
//   volatile — most likely to differ between sessions: skills, date, secrets

/** The agent's own words, as a layout entry. */
export const agentText = (text: string): { text: string } => ({ text });

/** One entry of a section: a server block's name, or the agent's text. */
export type SystemPromptEntry = string | { text: string };

export const SYSTEM_PROMPT_SECTIONS = ['stable', 'context', 'volatile'] as const;
export type SystemPromptSection = (typeof SYSTEM_PROMPT_SECTIONS)[number];

/** What an agent declares: its three sections, in order. */
export type SystemPromptLayout = Record<SystemPromptSection, SystemPromptEntry[]>;

/** What the session row stores: the three sections, assembled. */
export type StoredSystemPrompt = Record<SystemPromptSection, string>;

/** The stored sections as the system blocks a turn sends — in order, the
 *  empty ones left out. */
export const systemPromptBlocks = (p: StoredSystemPrompt): string[] =>
  SYSTEM_PROMPT_SECTIONS.map((s) => p[s]).filter((text) => text.trim() !== '');
