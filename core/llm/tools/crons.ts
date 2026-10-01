/**
 * The CRONS kit — `cron_list`, `cron_create`, `cron_update`, `cron_remove`:
 * the agent's door to the project's scheduled prompts, over
 * the /projects/:id/crons routes. Thin clients, like the secrets kit: the
 * rules (what a schedule may be, when it fires, name clashes) live on the
 * server and its refusals come back verbatim, written for the agent to act
 * on. Bound to the session's PROJECT at build time — and built only when
 * that project's `cron_enabled` is on: crons switched off means no cron
 * tools, not tools that schedule things which never run.
 *
 * What a cron IS is stated in the descriptions, not in a prompt: a tool's
 * description reaches the agent on every turn, unlike a frozen prompt. The
 * two facts an agent most often gets wrong — the time right now, and the
 * zone a schedule is read in — ride every answer (`now`, `timezone`), so
 * nothing has to be looked up first.
 */
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { pickKit, type KitPick } from './presets.js';
import { keyedProviders, REASONINGS, type Provider } from '../createAgent.js';

export interface CronToolsConfig {
  baseUrl: string;
  apiKey: string;
  /** The session's project — the crons it schedules run there. */
  projectId: string;
  /** `readonly` keeps `cron_list` only. */
  pick?: KitPick;
  /** Is the session in plan mode right now? The writing tools refuse while
   *  it says yes — the mid-turn /plan case (project.ts). */
  planMode?: () => boolean;
  fetch?: typeof fetch;
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

const WHAT_A_RUN_IS = 'A RUN HAS NO USER IN IT: it opens a fresh coding session in this project (its own checkout, ' +
  'cut from the base branch) and runs the prompt as one turn. It cannot see this conversation and cannot ask a ' +
  'question — the prompt must stand on its own. The session is the record of the run; it appears on /resume, named ' +
  'after the cron.';

const PROMPT_OR_SCRIPT = 'Exactly one of `prompt` / `script`. A prompt is an agent run — tokens on every fire. A script ' +
  'is a path in the repo run with `sh` in the same fresh session, NO model: for anything a shell script already ' +
  'does (a backup, a report, a health check). The script must be committed on the base branch. Its output and ' +
  'exit code are the session\'s record; a failure is logged, nobody is told.';

const SCHEDULE = 'A 5-field cron expression for something RECURRING ("0 9 * * *" = every day at 9am), or an ISO ' +
  'datetime for a ONE-TIME run ("2026-03-14T18:50:00"). Anything the user frames as a single future moment ' +
  '("tonight at 6:50", "tomorrow morning", "in 10 days") is one-time: it fires that minute and is then removed. ' +
  'Read in the project\'s time zone (every answer says which, and what time it is there now) — a datetime ' +
  'that has already passed is refused.';

/** The model a cron's runs use — only when the user names one. The enum IS
 *  how the agent knows what is valid: it rides the tool's schema. The
 *  providers are the ones this project can call (keyedProviders — the
 *  /settings picker's own list), read at build from the same settings
 *  answer that says whether crons are on. */
const modelFields = (providers: readonly Provider[]) => ({
  provider: z.enum(providers as [Provider, ...Provider[]]).nullable().optional().describe('ONLY when the user asks for a specific model. Goes with ' +
    '`model`: both or neither. Omit = the project\'s model; null clears an earlier choice.'),
  model: z.string().nullable().optional().describe('ONLY when the user asks: the model id on that provider ' +
    '(e.g. "claude-sonnet-4-5"). Goes with `provider`: both or neither. Null clears.'),
  reasoning: z.enum(REASONINGS).nullable().optional().describe('ONLY when the user asks: how hard the run thinks. ' +
    'Omit = the project\'s level; null clears.'),
});

const MUTATING = ['cron_create', 'cron_update', 'cron_remove'] as const;

export async function cronTools(cfg: CronToolsConfig): Promise<Record<string, Tool>> {
  const settings = await projectSettings(cfg);
  if (settings.cron_enabled?.value !== true) return {};
  return pickKit(buildCronTools(cfg, keyedProviders(settings)), MUTATING, cfg.pick);
}

/** The project's settings block, resolved by the server — `cron_enabled`
 *  and the credential entries the provider enum is read from. A read that
 *  fails throws, like every other kit's build — never a silent "no tools". */
async function projectSettings(cfg: CronToolsConfig): Promise<Record<string, { value: unknown; source?: string; meta?: { provider?: string } }>> {
  const f = cfg.fetch ?? fetch;
  const r = await f(`${cfg.baseUrl}/settings?project=${encodeURIComponent(cfg.projectId)}`, {
    headers: { authorization: `Bearer ${cfg.apiKey}` },
  });
  const j = await r.json() as Envelope<Record<string, { value: unknown; source?: string; meta?: { provider?: string } }>>;
  if (!j.ok) throw new Error(`could not read the project's settings: ${j.error.message}`);
  return j.data;
}

function buildCronTools(cfg: CronToolsConfig, providers: readonly Provider[]): Record<string, Tool> {
  const MODEL_FIELDS = modelFields(providers);
  const f = cfg.fetch ?? fetch;
  const base = `${cfg.baseUrl}/projects/${encodeURIComponent(cfg.projectId)}/crons`;
  // The envelope's data on success, its error otherwise — the server's
  // refusal is written for the agent and travels whole.
  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    if (method !== 'GET' && cfg.planMode?.()) {
      return { error: 'in plan mode — scheduling is off until the user switches back to code mode' };
    }
    const r = await f(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${cfg.apiKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await r.json() as Envelope<unknown>;
    return j.ok ? j.data : { error: j.error.message };
  };

  return {
    cron_list: tool({
      description: 'The project\'s crons, each with its schedule, its `prompt` (an agent run) or `script` (a path ' +
        'run with sh, no model), whether it is enabled, `once` (a one-time run), `last_run_at`, and the model its ' +
        'runs use (`provider`/`model`/`reasoning`; null = the project\'s). Call this before naming a cron — never guess a name. How a run went is ' +
        'in its session (session_list / /resume, named after the cron). The answer also carries the project\'s ' +
        '`timezone` and the time there `now`.',
      inputSchema: z.object({}),
      execute: async () => api('GET', ''),
    }),

    cron_create: tool({
      description: 'Schedule a prompt or a script to run unattended in this project. ' + WHAT_A_RUN_IS + ' ' +
        PROMPT_OR_SCRIPT + ' If the point of a prompt run is to tell the user something, the prompt must say so. A ' +
        'new cron is picked up within a minute, so schedule at least two minutes out — anything sooner, just do now. ' +
        'Returns the cron as stored.',
      inputSchema: z.object({
        name: z.string().describe('a short handle, unique in the project — how the cron is addressed from now on'),
        schedule: z.string().describe(SCHEDULE),
        prompt: z.string().optional().describe('what an agent run is asked to do — self-contained, every fact it needs written in'),
        script: z.string().optional().describe('a path in the repo, run with sh and no model, e.g. "scripts/nightly.sh"'),
        ...MODEL_FIELDS,
        enabled: z.boolean().optional().describe('false creates it paused; omit for on'),
      }),
      execute: async (args) => api('POST', '', args),
    }),

    cron_update: tool({
      description: 'Change a cron: any of its schedule, prompt or script, name, model, or enabled (false pauses it without ' +
        'removing it). Fields left out are kept; setting a prompt clears the script and the other way round. Call ' +
        'cron_list first for the name.',
      inputSchema: z.object({
        name: z.string().describe('the cron to change, from cron_list'),
        schedule: z.string().optional().describe(SCHEDULE),
        prompt: z.string().optional().describe('an agent run — replaces a script'),
        script: z.string().optional().describe('a path in the repo, run with sh and no model — replaces a prompt'),
        new_name: z.string().optional().describe('rename it'),
        ...MODEL_FIELDS,
        enabled: z.boolean().optional(),
      }),
      execute: async ({ name, new_name, ...rest }) =>
        api('PATCH', `/${encodeURIComponent(name)}`, { ...rest, ...(new_name !== undefined ? { name: new_name } : {}) }),
    }),

    cron_remove: tool({
      description: 'Remove a cron. The sessions its runs opened stay. Call cron_list first for the name.',
      inputSchema: z.object({ name: z.string().describe('the cron to remove, from cron_list') }),
      execute: async ({ name }) => api('DELETE', `/${encodeURIComponent(name)}`),
    }),
  };
}
