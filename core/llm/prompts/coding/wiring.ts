// The coding agent's wiring — the code that fills ./coding.ts (the
// document). No prompt text lives here.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fill } from '../template.js';
import { STAKEHOLDERS } from '../stakeholders.js';
import { VALUES } from '../values.js';
import { COMMUNICATION } from '../communication.js';
import { ENVIRONMENT } from '../environment.js';
import { SENDING_FILES } from '../sending.js';
import { SYSTEM_BASE, SYSTEM_WORKSPACE, SKILLS, SECRETS, CREDENTIALS_FACT, DATABASE_FACT, DATABASE_IN_CODE_FACT } from './coding.js';
import type { SkillMeta } from '../../../skills/skills.js';

/** One stored secret as the prompt (and the create response) carries it —
 *  name and description only, never the value. */
export interface SecretIndexEntry { name: string; description: string }

/** The workspace's settings the prompt states, resolved at session creation
 *  (POST /sessions carries them) and frozen with the rest of the prompt.
 *  Facts only, never instructions — off says NOTHING: the blank vanishes. */
export interface WorkspaceFacts {
  /** agent_git_credentials: the GitHub token is in the container env. */
  credentials?: boolean;
  /** agent_database: the agent has its own database and the database_query tool. */
  database?: boolean;
  /** agent_database_in_code: the project's code can reach that database too
   *  (AGENT_DATABASE_URL in the container). Meaningless without `database`. */
  databaseInCode?: boolean;
  /** agent_soul: the checkout's root SOUL.md, verbatim; '' or absent when
   *  the setting is off or the repo has no such file. */
  soul?: string;
  /** agent_agents_md: the checkout's root AGENTS.md, verbatim; '' or absent
   *  when the setting is off or the repo has no such file. */
  agents?: string;
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

export const SOUL_FILENAME = 'SOUL.md';
export const AGENTS_FILENAME = 'AGENTS.md';

/** The {soul} blank: the checkout's root SOUL.md, verbatim, read once at
 *  session creation and frozen like the skills. No file is the normal case
 *  (''); any other read failure throws — same rule as scanSkills, so a
 *  permissions problem never silently reads as "no soul". */
export async function readSoul(root: string): Promise<string> {
  const file = path.join(root, SOUL_FILENAME);
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return '';
    throw new Error(`could not read ${file}: ${(e as Error).message}`);
  }
}

/** The {agents} blank: the checkout's root AGENTS.md, verbatim. Same
 *  semantics as readSoul — ENOENT is fine, anything else throws. */
export async function readAgents(root: string): Promise<string> {
  const file = path.join(root, AGENTS_FILENAME);
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return '';
    throw new Error(`could not read ${file}: ${(e as Error).message}`);
  }
}

/** The coding agent's system prompt, in the two pieces the prompt cache
 *  wants: `base` is the agent itself, identical for every session;
 *  `workspace` carries this session's facts. Built once at session creation, stored on the row
 *  (sessions.system_prompt) and sent verbatim on every turn — so a prompt
 *  file edit reaches NEW sessions only, and a running session's cache never
 *  moves under it. */
export interface CodingPrompt { base: string; workspace: string }

export function codingPrompt(
  skills: SkillMeta[] = [], facts: WorkspaceFacts = {}, secrets: SecretIndexEntry[] = [],
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
      credentials: facts.credentials ? CREDENTIALS_FACT : '',
      database: facts.database ? (facts.databaseInCode ? DATABASE_IN_CODE_FACT : DATABASE_FACT) : '',
      soul: facts.soul ?? '',
      agents: facts.agents ?? '',
    }),
  };
}
