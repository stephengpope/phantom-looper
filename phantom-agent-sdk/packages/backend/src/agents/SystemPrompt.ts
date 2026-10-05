// The system prompt, assembled ONCE when a session is created and written
// to its row with it. Never changed after. Every turn sends it as stored.
//
// The agent sent its LAYOUT (@phantom-agent-sdk/client/systemPrompt): three
// sections, each an ordered list of entries — its own text, or the name of
// one of the blocks below that only the server can fill. This file fills
// the named blocks from the session's facts, keeps the text as is, drops
// what came out empty, and hands back the three sections.
//
// SERVER_PROMPT_BLOCKS is the whole catalog: a new block is one entry here
// and its text in phantom-looper/prompts/serverBlocks.ts. Which agent carries which
// block, and where, is the agent's layout — nothing here decides that.
import fsp from 'node:fs/promises';
import path from 'node:path';
import type Docker from 'dockerode';
import type { SystemPromptLayout, SystemPromptEntry, StoredSystemPrompt } from '@phantom-agent-sdk/client/systemPrompt';
import { SYSTEM_PROMPT_SECTIONS } from '@phantom-agent-sdk/client/systemPrompt';
import { fill } from '../prompt/template.js';
import { SKILLS_LIST, SECRETS_LIST, GITHUB_TOKEN, AGENT_DATABASE, AGENT_DATABASE_SHARED, TIME_DATE } from '../prompt/serverBlocks.js';
import { scanSkills, mergeSkills, type SkillMeta } from '../skills/skills.js';
import { Clock } from '../lib/clock.js';
import { systemSkills } from '../runtime/SystemSkills.js';
import type { Settings } from '../storage/Settings.js';
import type { ProjectRow } from '../storage/schema.js';
import { scopeNames, scopeOf } from '../lib/scopes.js';

/** What the blocks read: the session's checkout (null for a session with
 *  no files of its own), its project, the settings, and docker for the
 *  image's skills (absent in tests). */
export interface SystemPromptSource {
  projectId: string;
  project: ProjectRow;
  checkout: string | null;
  settings: Settings;
  docker?: Docker;
}

export class SystemPromptError extends Error {
  constructor(readonly code: 'unknown_block', message: string) { super(message); this.name = 'SystemPromptError'; }
}

/** The settings every block may read — resolved once per assembly. */
const SETTINGS_READ = ['container_image', 'agent_git_credentials', 'agent_database', 'agent_database_shared',
  'agent_soul', 'agent_agents_md', 'timezone'] as const;
type Resolved = Awaited<ReturnType<Settings['resolveMany']>> & Record<(typeof SETTINGS_READ)[number], unknown>;

interface BlockSource extends SystemPromptSource { resolved: Resolved }

const DESC_LIMIT = 60;
const clip = (text: string) => (text.length > DESC_LIMIT ? text.slice(0, DESC_LIMIT - 3) + '...' : text);

/** A root file of the checkout, verbatim. No file is the normal case ('');
 *  any other read failure throws — a permissions problem never silently
 *  reads as "no file". */
async function rootFile(checkout: string, name: string): Promise<string> {
  const file = path.join(checkout, name);
  try { return await fsp.readFile(file, 'utf8'); }
  catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return '';
    throw new Error(`could not read ${file}: ${(error as Error).message}`);
  }
}

export const SOUL_FILENAME = 'SOUL.md';
export const AGENTS_FILENAME = 'AGENTS.md';

/** The blocks only the server can fill, by name — each reads one thing off
 *  the session and answers its text, or '' when there is nothing to say. */
export const SERVER_PROMPT_BLOCKS = {
  soul_md: async (src: BlockSource): Promise<string> =>
    src.checkout && src.resolved.agent_soul ? rootFile(src.checkout, SOUL_FILENAME) : '',

  agents_md: async (src: BlockSource): Promise<string> =>
    src.checkout && src.resolved.agent_agents_md ? rootFile(src.checkout, AGENTS_FILENAME) : '',

  skills_list: async (src: BlockSource): Promise<string> => {
    if (!src.checkout) return '';
    const skills: SkillMeta[] = mergeSkills(
      await scanSkills(src.checkout),
      src.docker ? await systemSkills(src.docker, String(src.resolved.container_image)) : []);
    if (!skills.length) return '';
    return fill(SKILLS_LIST, { skillsList: skills.map((skill) => `- ${skill.name}: ${clip(skill.description)}`).join('\n') });
  },

  secrets_list: async (src: BlockSource): Promise<string> => {
    const byName = new Map<string, { name: string; description: string }>();
    // Chain order: a deeper layer's row replaces a shallower one's.
    for (const sec of await src.settings.listSecrets(Object.values(scopeNames(scopeOf(src.project))))) {
      byName.set(sec.name, { name: sec.name, description: sec.description });
    }
    const secrets = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (!secrets.length) return '';
    return fill(SECRETS_LIST, { secretsList: secrets.map((secret) => `- ${secret.name}: ${clip(secret.description)}`).join('\n') });
  },

  time_date: (src: BlockSource): Promise<string> =>
    Promise.resolve(fill(TIME_DATE, { date: new Clock(String(src.resolved.timezone)).date() })),

  github_token: (src: BlockSource): Promise<string> =>
    Promise.resolve(src.resolved.agent_git_credentials ? GITHUB_TOKEN : ''),

  agent_database: (src: BlockSource): Promise<string> =>
    Promise.resolve(src.resolved.agent_database
      ? (src.resolved.agent_database_shared ? AGENT_DATABASE_SHARED : AGENT_DATABASE) : ''),
} as const;

export type ServerPromptBlockName = keyof typeof SERVER_PROMPT_BLOCKS;
const isServerBlock = (name: string): name is ServerPromptBlockName =>
  Object.prototype.hasOwnProperty.call(SERVER_PROMPT_BLOCKS, name);

export class SystemPrompt {
  private constructor(private readonly assembled: StoredSystemPrompt) {}

  /** Refuse a layout naming a block the server does not have. Called BEFORE
   *  a session is created for it — a refused layout must leave no row. */
  static check(layout: SystemPromptLayout): void {
    for (const section of SYSTEM_PROMPT_SECTIONS) {
      for (const entry of layout[section]) {
        if (typeof entry === 'string' && !isServerBlock(entry)) {
          throw new SystemPromptError('unknown_block', `no server prompt block named "${entry}" (${section})`);
        }
      }
    }
  }

  /** Fill the agent's layout from the session. */
  static async assemble(layout: SystemPromptLayout, source: SystemPromptSource): Promise<SystemPrompt> {
    SystemPrompt.check(layout);
    const resolved = await source.settings.resolveMany(SETTINGS_READ, scopeOf(source.project)) as Resolved;
    const src: BlockSource = { ...source, resolved };
    const text = async (entry: SystemPromptEntry): Promise<string> =>
      typeof entry === 'string' ? SERVER_PROMPT_BLOCKS[entry as ServerPromptBlockName](src) : entry.text;
    const assembled = {} as StoredSystemPrompt;
    for (const section of SYSTEM_PROMPT_SECTIONS) {
      const parts: string[] = [];
      for (const entry of layout[section]) parts.push((await text(entry)).trim());
      assembled[section] = parts.filter((part) => part !== '').join('\n\n');
    }
    return new SystemPrompt(assembled);
  }

  /** The three sections, what the row stores. */
  sections(): StoredSystemPrompt { return { ...this.assembled }; }
}
