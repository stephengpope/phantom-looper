// The coding agent: its prompt (two blocks — the agent itself, identical
// for every session; the workspace's facts) and its default kits.
//
// The prompt is built ONCE at creation from what the server knows about the
// workspace — skills, secrets, four settings, the checkout's SOUL.md and
// AGENTS.md — fetched over the API here, and frozen on the row. The date
// in it is the day the session was born.
import { Agent, type AgentHandlers, type SessionRow } from '../../agent.js';
import { call, callRaw, type PhantomBackend } from '../../backend.js';
import type { ToolKit } from '../../toolkit.js';
import { fill } from '../../prompts/template.js';
import { todayFor } from '../../prompts/date.js';
import { STAKEHOLDERS } from '../../prompts/stakeholders.js';
import { VALUES } from '../../prompts/values.js';
import { COMMUNICATION } from '../../prompts/communication.js';
import { ENVIRONMENT } from '../../prompts/environment.js';
import { SENDING_FILES } from '../../prompts/sending.js';
import { SYSTEM_BASE, SYSTEM_WORKSPACE, SKILLS, SECRETS, CREDENTIALS_FACT, DATABASE_FACT, DATABASE_SHARED_FACT } from './prompt.js';
import { workspaceToolKit } from '../../kits/workspace.js';
import { skillsToolKit } from '../../kits/skills.js';
import { webToolKit } from '../../kits/web.js';
import { secretsToolKit } from '../../kits/secrets.js';
import { cronsToolKit } from '../../kits/crons.js';
import { databaseToolKit } from '../../kits/database.js';
import { kanbanReadToolKit } from '../../kits/kanban.js';
import { notifyToolKit } from '../../kits/notify.js';

export interface SkillIndexEntry { name: string; description: string }
export interface SecretIndexEntry { name: string; description: string }

/** The facts the workspace block states. Off says NOTHING: the line vanishes. */
export interface WorkspaceFacts {
  skills: SkillIndexEntry[];
  secrets: SecretIndexEntry[];
  credentials: boolean;
  database: boolean;
  databaseShared: boolean;
  soul: string;
  agents: string;
  /** The day the session was born, in the builder's zone. Frozen. */
  date: string;
}

const DESC_LIMIT = 60;
const clip = (s: string) => (s.length > DESC_LIMIT ? s.slice(0, DESC_LIMIT - 3) + '...' : s);

/** The two blocks, from the facts. Pure — tests and the create path share it. */
export function codingPromptBlocks(facts: WorkspaceFacts): string[] {
  const base = fill(SYSTEM_BASE, {
    stakeholders: STAKEHOLDERS, values: VALUES, communication: COMMUNICATION,
    environment: ENVIRONMENT, sending: SENDING_FILES,
  });
  const workspace = fill(SYSTEM_WORKSPACE, {
    skills: facts.skills.length ? fill(SKILLS, { skillsList: facts.skills.map((s) => `- ${s.name}: ${clip(s.description)}`).join('\n') }) : '',
    secrets: facts.secrets.length ? fill(SECRETS, { secretsList: facts.secrets.map((s) => `- ${s.name}: ${clip(s.description)}`).join('\n') }) : '',
    credentials: facts.credentials ? CREDENTIALS_FACT : '',
    database: facts.database ? (facts.databaseShared ? DATABASE_SHARED_FACT : DATABASE_FACT) : '',
    soul: facts.soul,
    agents: facts.agents,
  });
  return [base, `${workspace}\n\nCurrent date: ${facts.date}.`.trim()];
}

/** The facts, gathered over the API for one session. */
export async function gatherWorkspaceFacts(b: PhantomBackend, sessionId: string, workspaceId: string): Promise<WorkspaceFacts> {
  const ws = `?workspace=${encodeURIComponent(workspaceId)}`;
  const [skills, secrets, settings] = await Promise.all([
    call<{ skills: SkillIndexEntry[] }>(b, 'GET', '/skills', undefined, { sessionId }),
    call<{ secrets: SecretIndexEntry[] }>(b, 'GET', `/secrets${ws}`),
    call<Record<string, { value: unknown }>>(b, 'GET', `/settings${ws}`),
  ]);
  const on = (k: string) => settings[k]?.value === true;
  const readRepoFile = async (path: string): Promise<string> => {
    const r = await callRaw<{ content: string }>(b, 'POST', '/tools/read', { path }, { sessionId });
    if (r.ok) return stripLineNumbers(r.data?.content ?? '');
    if (r.error?.code === 'not_found') return '';
    throw new Error(`could not read ${path}: ${r.error?.message ?? 'unknown'}`);
  };
  const [soul, agents] = await Promise.all([
    on('agent_soul') ? readRepoFile('SOUL.md') : Promise.resolve(''),
    on('agent_agents_md') ? readRepoFile('AGENTS.md') : Promise.resolve(''),
  ]);
  return {
    skills: skills.skills ?? [], secrets: secrets.secrets ?? [],
    credentials: on('agent_git_credentials'), database: on('agent_database'), databaseShared: on('agent_database_shared'),
    soul, agents, date: todayFor(settings),
  };
}

/** The read tool numbers lines for display; the file itself is what the prompt wants. */
function stripLineNumbers(numbered: string): string {
  return numbered.split('\n').map((l) => l.replace(/^\s*\d+\t/, '')).join('\n');
}

export class CodingAgent extends Agent {
  readonly kind = 'coding';

  static create(backend: PhantomBackend, handlers: AgentHandlers, opts: { workspaceId: string }): Promise<CodingAgent> {
    return Agent.birth<CodingAgent>(CodingAgent, backend, handlers,
      () => call<SessionRow>(backend, 'POST', '/sessions', { workspace_id: opts.workspaceId }));
  }
  static resume(backend: PhantomBackend, handlers: AgentHandlers, sessionId: string): Promise<CodingAgent> {
    return Agent.wake<CodingAgent>(CodingAgent, backend, handlers, sessionId);
  }

  protected async systemPrompt(): Promise<string[]> {
    return codingPromptBlocks(await gatherWorkspaceFacts(this.backend, this.sessionId, this.workspaceId));
  }

  protected toolKits(): ToolKit[] {
    return [workspaceToolKit, skillsToolKit, webToolKit, secretsToolKit, cronsToolKit, databaseToolKit, kanbanReadToolKit, notifyToolKit];
  }
}
