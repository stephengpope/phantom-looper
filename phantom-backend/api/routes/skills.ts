// The skills surface — thin routes over skills.ts (the skill_* tools run the
// same code). Session travels in the same header as the tool routes.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { ToolError } from '../../tools/envelope.js';
import { ok, err, type AppCtx } from '../app.js';
import { SESSION_HEADER, toolSession } from '../sessionHeader.js';
import type { FsDeps } from './fs.js';
import { listSkills, loadSkill, manageSkill, type ManageBody } from '../../skills.js';

const TAG = { tags: ['skills'] };

const STATUS: Record<string, number> = {
  session_not_found: 404, session_destroyed: 410, no_folder: 400, skill_not_found: 404,
  invalid_args: 400, busy: 409, container_start_failed: 503,
};

export function skillsRoutes(app: FastifyInstance, ctx: AppCtx, deps: FsDeps) {
  const sessionHeader = {
    type: 'object',
    properties: { [SESSION_HEADER]: { type: 'string', description: 'Session id (ULID). Required.' } },
  };
  const handle = (reply: FastifyReply, e: unknown) => {
    if (e instanceof ToolError) return reply.code(STATUS[e.code] ?? 400).send(err(e.code, e.message, e.retryable));
    throw e;
  };

  // List — live scan of the session's working tree, merged with the image's
  // baked system tier (repo shadows). The prompt's list is the snapshot from
  // session creation; this is the current truth.
  app.get('/skills', { schema: { ...TAG, summary: "The session's skills, live (repo + image system tier)",
    headers: sessionHeader,
    response: { 200: { type: 'object', properties: { ok: { type: 'boolean' }, data: {
      type: 'object', properties: { skills: { type: 'array', items: {
        type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } } } } } } } } } } },
  async (req, reply) => {
    try {
      const { session, folderId } = await toolSession(ctx.sessions, req.headers);
      return ok(await listSkills(ctx, deps, session, folderId));
    } catch (e) { return handle(reply, e); }
  });

  // Load — the whole SKILL.md plus the names of its bundled files in ONE
  // call; `?file=` fetches one bundled file instead.
  app.get<{ Params: { name: string }; Querystring: { file?: string } }>(
    '/skills/:name', { schema: { ...TAG, summary: "One skill's instructions + bundled file names",
      headers: sessionHeader,
      params: { type: 'object', properties: { name: { type: 'string' } } },
      querystring: { type: 'object', properties: { file: { type: 'string', description: 'bundled file to fetch instead (references/… etc.)' } } } } },
    async (req, reply) => {
      try {
        const { session, folderId } = await toolSession(ctx.sessions, req.headers);
        return ok(await loadSkill(ctx, deps, session, folderId, req.params.name, req.query.file));
      } catch (e) { return handle(reply, e); }
    });

  // Manage — every write, validated, through the container.
  app.post<{ Body: ManageBody }>('/skills', { schema: { ...TAG, summary: 'Create, patch, edit or delete a skill',
    headers: sessionHeader,
    body: { type: 'object', required: ['action', 'name'], properties: {
      action: { type: 'string', enum: ['create', 'edit', 'patch', 'delete', 'write_file', 'remove_file'] },
      name: { type: 'string' },
      content: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
      file_path: { type: 'string' },
      file_content: { type: 'string' },
    } } } },
  async (req, reply) => {
    try {
      const { session, folderId } = await toolSession(ctx.sessions, req.headers);
      return ok(await manageSkill(ctx, deps, session, folderId, req.body));
    } catch (e) { return handle(reply, e); }
  });
}
