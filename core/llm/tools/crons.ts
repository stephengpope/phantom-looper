/**
 * The CRONS kit — `cron_list`, `cron_create`, `cron_update`, `cron_remove`:
 * the agent's door to the workspace's scheduled prompts, over
 * the /workspaces/:id/crons routes. Thin clients, like the secrets kit: the
 * rules (what a schedule may be, when it fires, name clashes) live on the
 * server and its refusals come back verbatim, written for the agent to act
 * on. Bound to the session's WORKSPACE at build time — and built only when
 * that workspace's `cron_enabled` is on: crons switched off means no cron
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

export interface CronToolsConfig {
  baseUrl: string;
  apiKey: string;
  /** The session's workspace — the crons it schedules run there. */
  workspaceId: string;
  /** `readonly` keeps `cron_list` only. */
  pick?: KitPick;
  /** Is the session in plan mode right now? The writing tools refuse while
   *  it says yes — the mid-turn /plan case (workspace.ts). */
  planMode?: () => boolean;
  fetch?: typeof fetch;
}

type Envelope<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

const WHAT_A_RUN_IS = 'A RUN HAS NO USER IN IT: it opens a fresh coding session in this workspace (its own checkout) ' +
  'and runs the prompt as one turn. It cannot see this conversation and cannot ask a question — the prompt must ' +
  'stand on its own. The session is the record of the run; it appears on /resume, named after the cron.';

const SCHEDULE = 'A 5-field cron expression for something RECURRING ("0 9 * * *" = every day at 9am), or an ISO ' +
  'datetime for a ONE-TIME run ("2026-03-14T18:50:00"). Anything the user frames as a single future moment ' +
  '("tonight at 6:50", "tomorrow morning", "in 10 days") is one-time: it fires that minute and is then removed. ' +
  'Read in the workspace\'s time zone (every answer says which, and what time it is there now) — a datetime ' +
  'that has already passed is refused.';

const MUTATING = ['cron_create', 'cron_update', 'cron_remove'] as const;

export async function cronTools(cfg: CronToolsConfig): Promise<Record<string, Tool>> {
  if (!await cronsEnabled(cfg)) return {};
  return pickKit(buildCronTools(cfg), MUTATING, cfg.pick);
}

/** The workspace's `cron_enabled`, resolved by the server. Unreachable or
 *  unreadable reads as off — no tools rather than tools that cannot work. */
async function cronsEnabled(cfg: CronToolsConfig): Promise<boolean> {
  const f = cfg.fetch ?? fetch;
  try {
    const r = await f(`${cfg.baseUrl}/settings?workspace=${encodeURIComponent(cfg.workspaceId)}`, {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
    });
    const j = await r.json() as Envelope<Record<string, { value: unknown }>>;
    return j.ok && j.data.cron_enabled?.value === true;
  } catch { return false; }
}

function buildCronTools(cfg: CronToolsConfig): Record<string, Tool> {
  const f = cfg.fetch ?? fetch;
  const base = `${cfg.baseUrl}/workspaces/${encodeURIComponent(cfg.workspaceId)}/crons`;
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
      description: 'The workspace\'s scheduled prompts (crons), each with its schedule, whether it is enabled, `once` ' +
        '(a one-time run) and `last_run_at`. Call this before naming a cron — never guess a name. How a run went is ' +
        'in its session (session_list / /resume, named after the cron). The answer also carries the workspace\'s ' +
        '`timezone` and the time there `now`.',
      inputSchema: z.object({}),
      execute: async () => api('GET', ''),
    }),

    cron_create: tool({
      description: 'Schedule a prompt to run unattended in this workspace. ' + WHAT_A_RUN_IS + ' If the point of the ' +
        'run is to tell the user something, the prompt must say so. A new cron is picked up within a minute, so schedule ' +
        'at least two minutes out — anything sooner, just do now. Returns the cron as stored.',
      inputSchema: z.object({
        name: z.string().describe('a short handle, unique in the workspace — how the cron is addressed from now on'),
        schedule: z.string().describe(SCHEDULE),
        prompt: z.string().describe('what the run is asked to do — self-contained, every fact it needs written in'),
        enabled: z.boolean().optional().describe('false creates it paused; omit for on'),
      }),
      execute: async (args) => api('POST', '', args),
    }),

    cron_update: tool({
      description: 'Change a cron: any of its schedule, prompt, name, or enabled (false pauses it without removing ' +
        'it). Fields left out are kept. Call cron_list first for the name.',
      inputSchema: z.object({
        name: z.string().describe('the cron to change, from cron_list'),
        schedule: z.string().optional().describe(SCHEDULE),
        prompt: z.string().optional(),
        new_name: z.string().optional().describe('rename it'),
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
