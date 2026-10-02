// The CRON tools — cron_list, cron_create, cron_update, cron_remove, over
// Crons (crons.ts). Offered only when the project's `cron_enabled` is on:
// crons off means no cron tools. The rules (what a schedule may be, name
// clashes) live in Crons; its refusals come back verbatim, written for the
// agent.
import { CronError, type CronFields } from 'phantom-backend-sdk';
import { REASONINGS } from '../../core/llm/createAgent.js';
import { nullable, obj, refusal, str, type OfferCtx, type ToolCtx, type ToolDef } from './def.js';

const WHAT_A_RUN_IS = 'A RUN HAS NO USER IN IT: it opens a fresh coding session in this project (its own checkout, ' +
  'cut from the base branch) and runs the prompt as one turn. It cannot see this conversation and cannot ask a ' +
  'question — the prompt must stand on its own. The session is the record of the run, named after the cron.';
const PROMPT_OR_SCRIPT = 'Exactly one of `prompt` / `script`. A prompt is an agent run — tokens on every fire. A script ' +
  'is a path in the repo run with `sh` in the same fresh session, NO model: for anything a shell script already ' +
  'does (a backup, a report, a health check). The script must be committed on the base branch. Its output and ' +
  'exit code are the session\'s record; a failure is logged, nobody is told.';
const SCHEDULE = 'A 5-field cron expression for something RECURRING ("0 9 * * *" = every day at 9am), or an ISO ' +
  'datetime for a ONE-TIME run ("2026-03-14T18:50:00"). Anything the user frames as a single future moment ' +
  '("tonight at 6:50", "tomorrow morning", "in 10 days") is one-time: it fires that minute and is then removed. ' +
  'Read in the project\'s time zone (every answer says which, and what time it is there now) — a datetime ' +
  'that has already passed is refused.';

/** The model a cron's runs use — only when the user names one. Which
 *  providers are valid is Crons' rule: a provider with no key is refused
 *  with the valid ones named, and the agent corrects. */
const MODEL_FIELDS = {
  provider: nullable('string', 'ONLY when the user asks for a specific model: a provider with a key ' +
    'on /keys (the server names the valid ones if refused). Goes with `model`: both or neither. Omit = the ' +
    'project\'s model; null clears an earlier choice.'),
  model: nullable('string', 'ONLY when the user asks: the model id on that provider ' +
    '(e.g. "claude-sonnet-4-5"). Goes with `provider`: both or neither. Null clears.'),
  reasoning: { type: ['string', 'null'], enum: [...REASONINGS, null],
    description: 'ONLY when the user asks: how hard the run thinks. Omit = the project\'s level; null clears.' },
};

const enabled = async ({ app, project }: OfferCtx) => Boolean(await app.settings.resolve('cron_enabled', { projectId: project.id }));

/** Every answer carries the zone and the time there — what a caller
 *  writing a datetime needs and never otherwise has. */
async function stamped<T>(ctx: ToolCtx, fn: (clock: Awaited<ReturnType<ToolCtx['app']['settings']['clockFor']>>) => Promise<T>) {
  const clock = await ctx.app.settings.clockFor({ projectId: ctx.project.id });
  try {
    return { timezone: clock.timezone, now: clock.now().toISOString(), ...(await fn(clock)) };
  } catch (e) {
    if (e instanceof CronError) throw refusal(e.code, e.message);
    throw e;
  }
}


export const CRON_TOOLS: ToolDef[] = [
  {
    name: 'cron_list',
    summary: "The project's crons.",
    description: 'The project\'s crons, each with its schedule, its `prompt` (an agent run) or `script` (a path ' +
      'run with sh, no model), whether it is enabled, `once` (a one-time run), `last_run_at`, and the model its ' +
      'runs use (`provider`/`model`/`reasoning`; null = the project\'s). Call this before naming a cron — never guess a name. How a run went is ' +
      'in its session, named after the cron. The answer also carries the project\'s `timezone` and the time there `now`.',
    input: obj({}),
    mutates: false, group: 'crons', offered: enabled,
    execute: (ctx) => stamped(ctx, async () => ({ crons: await ctx.app.crons.list(ctx.project) })),
  },
  {
    name: 'cron_create',
    summary: 'Schedule a prompt or a script.',
    description: 'Schedule a prompt or a script to run unattended in this project. ' + WHAT_A_RUN_IS + ' ' +
      PROMPT_OR_SCRIPT + ' If the point of a prompt run is to tell the user something, the prompt must say so. A ' +
      'new cron is picked up within a minute, so schedule at least two minutes out — anything sooner, just do now. ' +
      'Returns the cron as stored.',
    input: obj({
      name: str('a short handle, unique in the project — how the cron is addressed from now on'),
      schedule: str(SCHEDULE),
      prompt: str('what an agent run is asked to do — self-contained, every fact it needs written in'),
      script: str('a path in the repo, run with sh and no model, e.g. "scripts/nightly.sh"'),
      ...MODEL_FIELDS,
      enabled: { type: 'boolean', description: 'false creates it paused; omit for on' },
    }, ['name', 'schedule']),
    mutates: true, group: 'crons', offered: enabled,
    execute: (ctx, a) => stamped(ctx, async (clock) => ({ cron: await ctx.app.crons.create(ctx.project, a as CronFields, clock) })),
  },
  {
    name: 'cron_update',
    summary: 'Change a cron.',
    description: 'Change a cron: any of its schedule, prompt or script, name, model, or enabled (false pauses it without ' +
      'removing it). Fields left out are kept; setting a prompt clears the script and the other way round. Call ' +
      'cron_list first for the name.',
    input: obj({
      name: str('the cron to change, from cron_list'),
      schedule: str(SCHEDULE),
      prompt: str('an agent run — replaces a script'),
      script: str('a path in the repo, run with sh and no model — replaces a prompt'),
      new_name: str('rename it'),
      ...MODEL_FIELDS,
      enabled: { type: 'boolean' },
    }, ['name']),
    mutates: true, group: 'crons', offered: enabled,
    execute: (ctx, { name, new_name, ...rest }) => stamped(ctx, async (clock) => ({
      cron: await ctx.app.crons.update(ctx.project, String(name),
        { ...(rest as CronFields), ...(new_name !== undefined ? { name: String(new_name) } : {}) }, clock) })),
  },
  {
    name: 'cron_remove',
    summary: 'Remove a cron.',
    description: 'Remove a cron. The sessions its runs opened stay. Call cron_list first for the name.',
    input: obj({ name: str('the cron to remove, from cron_list') }, ['name']),
    mutates: true, group: 'crons', offered: enabled,
    async execute(ctx, a) {
      const name = String(a.name);
      if (!(await ctx.app.crons.remove(ctx.project, name))) throw refusal('not_found', `no cron named "${name}" in this project`);
      return { deleted: name };
    },
  },
];
