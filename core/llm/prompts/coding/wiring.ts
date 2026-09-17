// The coding agent's wiring — the code that fills ./coding.ts (the
// document). No prompt text lives here.
import { fill } from '../template.js';
import { STAKEHOLDERS } from '../stakeholders.js';
import { VALUES } from '../values.js';
import { COMMUNICATION } from '../communication.js';
import { ENVIRONMENT } from '../environment.js';
import { SENDING_FILES } from '../sending.js';
import { SYSTEM_BASE, SYSTEM_WORKSPACE, SKILLS, SECRETS, CREDENTIALS_FACT } from './coding.js';
import type { SkillMeta } from '../../../skills/skills.js';

/** One stored secret as the prompt (and the create response) carries it —
 *  name and description only, never the value. */
export interface SecretIndexEntry { name: string; description: string }

/** The workspace's git settings, resolved at session creation (POST /sessions
 *  carries them) and frozen with the rest of the prompt. Facts only, never
 *  instructions — off says NOTHING: the blank vanishes. */
export interface GitFacts {
  /** agent_git_credentials: the GitHub token is in the container env. */
  credentials?: boolean;
}

const DESC_LIMIT = 60;
const clip = (s: string) => (s.length > DESC_LIMIT ? s.slice(0, DESC_LIMIT - 3) + '...' : s);

/** The {skills} blank: the session's skills, scanned server-side and frozen;
 *  '' with none. Descriptions clip to 60 chars (hermes's prompt budget — the
 *  trigger must live in the first 57; the full text stays behind skill_list). */
export function skillsIndex(skills: SkillMeta[]): string {
  if (!skills.length) return '';
  return fill(SKILLS, { skillsList: skills.map((s) => `- ${s.name}: ${clip(s.description)}`).join('\n') });
}

/** The {secrets} blank: the stored secrets at session creation (names +
 *  descriptions, never values), frozen like the skills; '' with none.
 *  secret_list is the live view afterwards. */
export function secretsIndex(secrets: SecretIndexEntry[]): string {
  if (!secrets.length) return '';
  return fill(SECRETS, { secretsList: secrets.map((s) => `- ${s.name}: ${clip(s.description)}`).join('\n') });
}

/** The coding agent's system prompt, in the two pieces the prompt cache
 *  wants: `base` is the agent itself, identical for every session;
 *  `workspace` carries this session's facts. Built once at session creation, stored on the row
 *  (sessions.system_prompt) and sent verbatim on every turn — so a prompt
 *  file edit reaches NEW sessions only, and a running session's cache never
 *  moves under it. */
export interface CodingPrompt { base: string; workspace: string }

export function codingPrompt(
  skills: SkillMeta[] = [], git: GitFacts = {}, secrets: SecretIndexEntry[] = [],
): CodingPrompt {
  return {
    base: fill(SYSTEM_BASE, {
      stakeholders: STAKEHOLDERS,
      values: VALUES,
      communication: COMMUNICATION,
      environment: ENVIRONMENT,
      sending: SENDING_FILES,
    }),
    workspace: fill(SYSTEM_WORKSPACE, {
      skills: skillsIndex(skills),
      secrets: secretsIndex(secrets),
      credentials: git.credentials ? CREDENTIALS_FACT : '',
    }),
  };
}
