// The coding agent, in one place: its prompt stack and its kit.
//
// Prompt: prompts/coding/coding.ts systemPrompt — the whole prompt in one
// list, assembled once when the session is created and FROZEN with it (the
// TUI stores it in the transcript header and replays it verbatim on resume;
// editing a prompt file changes new sessions only). Time never enters the
// frozen text: the current date — date only, Shockwave's rule — is appended
// below it at every agent build.
//
// Kit: the caller's — the seven file tools + skills + web + secrets +
// `kanban_card_read` (bound to the session's own workspace) and, inside a
// loop run, `kanban_card_block`. The caller builds them all (they need the server, the session id, and — for the board —
// the window) and hands them in.
import type { Tool } from 'ai';
import { createAgent, type Agent, type ModelConfig } from '../createAgent.js';
import { withCurrentDate } from '../prompts/template.js';
import { systemPrompt, type GitFacts, type SecretIndexEntry } from '../prompts/coding/wiring.js';
import type { SkillMeta } from '../../skills/skills.js';

/** The frozen string: skills are scanned before the session's first build and
 *  FROZEN with the rest; `git` is the workspace's resolved facts, `secrets`
 *  the stored secrets index (names + descriptions, never values), and
 *  `environment` the fs image's probed facts line — POST /sessions carries
 *  all four, frozen the same way. */
export function codingInstructions(
  skills: SkillMeta[] = [], git?: GitFacts, secrets: SecretIndexEntry[] = [],
  environment = '',
): string {
  return systemPrompt(skills, git, secrets, environment);
}

export function codingAgent(
  model: ModelConfig,
  tools: Record<string, Tool>,
  opts: { maxSteps?: number | null; instructions?: string } = {},
): Agent {
  return createAgent(model, {
    instructions: withCurrentDate(opts.instructions ?? codingInstructions()),
    tools,
    maxSteps: opts.maxSteps,
  });
}
