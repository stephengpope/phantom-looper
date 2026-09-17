// The coding agent's wiring — the code that fills ./coding.ts (the
// document). No prompt text lives here.
import { fill } from '../template.js';
import { STAKEHOLDERS } from '../stakeholders.js';
import { VALUES } from '../values.js';
import { COMMUNICATION } from '../communication.js';
import { ENVIRONMENT } from '../environment.js';
import { SENDING_FILES } from '../sending.js';
import { SYSTEM, SYSTEM_STATIC, SKILLS, SECRETS, CREDENTIALS_FACT } from './coding.js';
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

/** The full system prompt as a single string — what gets frozen in the
 *  transcript header. The combined template interpolates SYSTEM_STATIC
 *  (stakeholders, values, communication, environment, sending) and adds the
 *  per-workspace blanks after it. */
export function systemPrompt(
  skills: SkillMeta[] = [], git: GitFacts = {}, secrets: SecretIndexEntry[] = [],
): string {
  return fill(SYSTEM, {
    stakeholders: STAKEHOLDERS,
    values: VALUES,
    communication: COMMUNICATION,
    environment: ENVIRONMENT,
    sending: SENDING_FILES,
    skills: skillsIndex(skills),
    secrets: secretsIndex(secrets),
    credentials: git.credentials ? CREDENTIALS_FACT : '',
  });
}

/** The static system prompt block — identical across every workspace and
 *  session. No per-workspace inputs. This is the prefix that gets cached
 *  globally via an Anthropic breakpoint. */
export function staticSystemPrompt(): string {
  return fill(SYSTEM_STATIC, {
    stakeholders: STAKEHOLDERS,
    values: VALUES,
    communication: COMMUNICATION,
    environment: ENVIRONMENT,
    sending: SENDING_FILES,
  });
}
