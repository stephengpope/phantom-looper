// The CRONS kit — cron_list, cron_create, cron_update, cron_remove, over
// the /workspaces/:id/crons routes. Built only when the workspace's
// `cron_enabled` is on: crons off means no cron tools. The rules (what a
// schedule may be, name clashes) live on the server; its refusals come back
// verbatim, written for the agent.
import { tool } from 'ai';
import { z } from 'zod';
import { call, callRaw } from '../backend.js';
import { PhantomError } from '../errors.js';
import type { BuiltTools, ToolKit, ToolKitContext } from '../toolkit.js';

const WHAT_A_RUN_IS = 'A RUN HAS NO USER IN IT: it opens a fresh coding session in this workspace (its own checkout, ' +
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
  'Read in the workspace\'s time zone (every answer says which, and what time it is there now) — a datetime ' +
  'that has already passed is refused.';

export const cronsToolKit: ToolKit = {
  name: 'crons',
  version: (ctx) => ctx.workspaceId,
  async build(ctx: ToolKitContext): Promise<BuiltTools> {
    let settings: Record<string, { value: unknown }>;
    try {
      settings = await call(ctx.backend, 'GET', `/settings?workspace=${encodeURIComponent(ctx.workspaceId)}`);
    } catch (e) {
      throw new PhantomError('tool_build_failed', `could not read the workspace's settings: ${(e as Error).message}`, { cause: e });
    }
    if (settings.cron_enabled?.value !== true) return { tools: {}, mutating: [] };
    const base = `/workspaces/${encodeURIComponent(ctx.workspaceId)}/crons`;
    const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
      const j = await callRaw(ctx.backend, method, `${base}${path}`, body);
      return j.ok ? j.data : { error: j.error?.message };
    };
    return { mutating: ['cron_create', 'cron_update', 'cron_remove'], tools: {
      cron_list: tool({
        description: 'The workspace\'s crons, each with its schedule, its `prompt` (an agent run) or `script` (a path ' +
          'run with sh, no model), whether it is enabled, `once` (a one-time run) and `last_run_at`. Call this before naming a cron — never guess a name. How a run went is ' +
          'in its session (session_list / /resume, named after the cron). The answer also carries the workspace\'s ' +
          '`timezone` and the time there `now`.',
        inputSchema: z.object({}),
        execute: () => api('GET', ''),
      }),
      cron_create: tool({
        description: 'Schedule a prompt or a script to run unattended in this workspace. ' + WHAT_A_RUN_IS + ' ' +
          PROMPT_OR_SCRIPT + ' If the point of a prompt run is to tell the user something, the prompt must say so. A ' +
          'new cron is picked up within a minute, so schedule at least two minutes out — anything sooner, just do now. ' +
          'Returns the cron as stored.',
        inputSchema: z.object({
          name: z.string().describe('a short handle, unique in the workspace — how the cron is addressed from now on'),
          schedule: z.string().describe(SCHEDULE),
          prompt: z.string().optional().describe('what an agent run is asked to do — self-contained, every fact it needs written in'),
          script: z.string().optional().describe('a path in the repo, run with sh and no model, e.g. "scripts/nightly.sh"'),
          enabled: z.boolean().optional().describe('false creates it paused; omit for on'),
        }),
        execute: (args) => api('POST', '', args),
      }),
      cron_update: tool({
        description: 'Change a cron: any of its schedule, prompt or script, name, or enabled (false pauses it without ' +
          'removing it). Fields left out are kept; setting a prompt clears the script and the other way round. Call ' +
          'cron_list first for the name.',
        inputSchema: z.object({
          name: z.string().describe('the cron to change, from cron_list'),
          schedule: z.string().optional().describe(SCHEDULE),
          prompt: z.string().optional().describe('an agent run — replaces a script'),
          script: z.string().optional().describe('a path in the repo, run with sh and no model — replaces a prompt'),
          new_name: z.string().optional().describe('rename it'),
          enabled: z.boolean().optional(),
        }),
        execute: ({ name, new_name, ...rest }) =>
          api('PATCH', `/${encodeURIComponent(name)}`, { ...rest, ...(new_name !== undefined ? { name: new_name } : {}) }),
      }),
      cron_remove: tool({
        description: 'Remove a cron. The sessions its runs opened stay. Call cron_list first for the name.',
        inputSchema: z.object({ name: z.string().describe('the cron to remove, from cron_list') }),
        execute: ({ name }) => api('DELETE', `/${encodeURIComponent(name)}`),
      }),
    } };
  },
};
