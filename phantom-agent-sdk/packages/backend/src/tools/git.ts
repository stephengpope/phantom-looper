// The GIT tools — git_auto_push, git_auto_pull: land a session's work on the
// base branch, or bring the base branch into it, over the same auto-push /
// auto-pull the archive trigger and the /git routes run. Every step lands on
// the target session's live feed as it happens (`by` = the caller), so a
// watcher sees the progress; the tool answers the result.
//
// The assistant's: moving code between branches is a person's call, or the
// assistant's on their behalf. The coding agent does not carry these. The
// target is the session named by `id`, else the one this assistant is
// following (its workspace is that session's).
import { ToolError } from './envelope.js';
import { obj, refusal, str, type ToolCtx, type ToolDef } from './def.js';

const idField = str('a session id; omit for the session this assistant is following');

/** The session the tool acts on and its project, or the refusal. */
async function target(ctx: ToolCtx, a: Record<string, unknown>) {
  const id = typeof a.id === 'string' && a.id ? a.id : ctx.session.workspaceId;
  if (!id) throw refusal('no_session', 'no session to act on — name one with `id`');
  const session = await ctx.app.sessions.get(id);
  if (!session) throw refusal('session_not_found', `no session ${id}`);
  if (session.status !== 'active') throw refusal('session_destroyed', `session ${id} is ${session.status}`);
  const project = await ctx.app.projects.get(session.projectId);
  // Another organization's session is not there, whoever runs this agent.
  if (!project || project.organizationId !== ctx.project.organizationId) throw refusal('session_not_found', `no session ${id}`);
  return { session, project };
}

/** The result, or the operation's own failure as a result the model reads. */
async function run<T extends { result: string }>(body: () => Promise<T>): Promise<T | { result: string; reason: string }> {
  try { return await body(); }
  catch (error) {
    if (error instanceof ToolError && error.code === 'busy') return { result: 'busy', reason: error.message };
    return { result: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
}

export const GIT_TOOLS: ToolDef[] = [
  {
    name: 'git_auto_push',
    summary: "Land a session's work on the base branch.",
    description: 'Land a session\'s work on the base branch: commit, replay on base, verify, push. ' +
      'The session this assistant is following unless an id is given. Reports how it went ' +
      '(pushed | nothing | blocked | error | busy).',
    input: obj({ id: idField }),
    mutates: true, group: 'git',
    async execute(ctx, a) {
      const on = await target(ctx, a);
      return { session: on.session.id, ...await run(() => ctx.app.git.autoPush(on.session, on.project, undefined, ctx.client)) };
    },
  },
  {
    name: 'git_auto_pull',
    summary: 'Bring the base branch into a session.',
    description: 'Bring the base branch into a session: commit its work, replay on base, verify, push the branch. ' +
      'The session this assistant is following unless an id is given. Reports how it went ' +
      '(merged | clean | blocked | error | busy).',
    input: obj({ id: idField }),
    mutates: true, group: 'git',
    async execute(ctx, a) {
      const on = await target(ctx, a);
      return { session: on.session.id, ...await run(() => ctx.app.git.autoPull(on.session, on.project, undefined, ctx.client)) };
    },
  },
];
