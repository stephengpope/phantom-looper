// The coding agent, in one place: its prompt stack and its kit.
//
// Prompt: prompts/coding/coding.ts systemPrompt — the whole prompt in one
// list, assembled once when the session is created and FROZEN with it (the
// TUI stores it in the transcript header and replays it verbatim on resume;
// editing a prompt file changes new sessions only). Time never enters the
// frozen text: the current date — date only, Shockwave's rule — is appended
// below it at every agent build.
//
// Prompt caching: the system prompt is split into two blocks at agent-build
// time (not at storage time — the transcript header stores the combined
// string). Block 1 (static) is identical across all workspaces and sessions;
// block 2 (workspace) varies by skills/secrets/credentials/env. Each gets
// an Anthropic cache breakpoint, plus the last conversation message — 3 of
// 4 allowed. Other providers ignore the Anthropic-namespaced options and
// cache automatically.
//
// Kit: the caller's — the file and task tools + skills + web + secrets +
// `kanban_card_read` (bound to the session's own workspace) and, inside a
// loop run, `kanban_card_block`. The caller builds them all (they need the server, the session id, and — for the board —
// the window) and hands them in.
import type { SystemModelMessage, Tool } from 'ai';
import { createAgent, CACHE_TTL, type Agent, type ModelConfig } from '../createAgent.js';
import { withCurrentDate } from '../prompts/template.js';
import { systemPrompt, staticSystemPrompt, type GitFacts, type SecretIndexEntry } from '../prompts/coding/wiring.js';
import type { SkillMeta } from '../../skills/skills.js';

/** The frozen string: skills are scanned before the session's first build and
 *  FROZEN with the rest; `git` is the workspace's resolved facts, `secrets`
 *  the stored secrets index (names + descriptions, never values), and
 *  `environment` the session image's probed facts line — POST /sessions carries
 *  all four, frozen the same way. */
export function codingInstructions(
  skills: SkillMeta[] = [], git?: GitFacts, secrets: SecretIndexEntry[] = [],
  environment = '',
): string {
  return systemPrompt(skills, git, secrets, environment);
}

/** The static system prompt block — identical across every workspace and
 *  session. Computed once (no per-session inputs) and cached in-process. */
let _staticBlock: string | undefined;
function getStaticBlock(): string {
  return (_staticBlock ??= staticSystemPrompt());
}

/** Split a combined instructions string into two SystemModelMessages for
 *  prompt caching. The static prefix is always the same (regenerated from
 *  templates); the workspace portion is whatever follows it in the combined
 *  string. The current date is appended to the workspace block.
 *
 *  Old sessions (frozen before this change) embed env facts in a different
 *  position, so the prefix won't match. In that case we fall back to a
 *  single unsplit block — no cross-session static cache, but no duplication
 *  either. The last-message breakpoint still provides within-session caching. */
function splitInstructions(combined: string): SystemModelMessage[] {
  const staticBlock = getStaticBlock();
  const cacheControl = { anthropic: { cacheControl: { type: 'ephemeral' as const, ttl: CACHE_TTL } } };
  if (combined.startsWith(staticBlock)) {
    const workspace = combined.slice(staticBlock.length).replace(/^\n+/, '');
    return [
      { role: 'system', content: staticBlock, providerOptions: cacheControl },
      { role: 'system', content: withCurrentDate(workspace), providerOptions: cacheControl },
    ];
  }
  // Can't split — old format. Single block, still gets a breakpoint so the
  // workspace-level cache works within this session.
  return [
    { role: 'system', content: withCurrentDate(combined), providerOptions: cacheControl },
  ];
}

export function codingAgent(
  model: ModelConfig,
  tools: Record<string, Tool>,
  opts: { maxSteps?: number | null; instructions?: string } = {},
): Agent {
  const combined = opts.instructions ?? codingInstructions();
  return createAgent(model, {
    instructions: splitInstructions(combined),
    tools,
    maxSteps: opts.maxSteps,
  });
}
