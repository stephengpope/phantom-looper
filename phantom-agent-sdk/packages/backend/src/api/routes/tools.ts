// The tool routes — one surface for every tool an agent can call, off the
// registry (tools/registry.ts):
//
//   POST /sessions/:id/turn-start         what an agent of that kind has on that
//                                        session right now — a client builds
//                                        its tools from this and nothing else
//   POST /tools/:name                    run one; the session travels in a
//                                        header, never in the schema the
//                                        model sees
//   GET  /tools                          the file tools' definitions, for the
//                                        clients that predate the agent
//                                        listing
//
// Tools take no lock — an agent fans out parallel calls in one turn and they
// all just run; the session/turn lock is the only lock.
import type { FastifyInstance } from 'fastify';
import type { SessionRow, ProjectRow } from '../../storage/schema.js';
import { TOOLS, type FileTools, type ToolCtx } from '../../tools/registry.js';
import { ToolError } from '../../tools/envelope.js';
import { ok, err } from '../HttpApi.js';
import type { PhantomBackend } from '../../PhantomBackend.js';
import { SESSION_HEADER } from '../../agents/sessionHeader.js';
import { fileTools, fsDeps } from './fs.js';

const STATUS: Record<string, number> = {
  not_found: 404, session_not_found: 404, duplicate_name: 409, database_off: 409, database_unavailable: 503, telegram_unavailable: 503, sql_error: 400, session_destroyed: 410, no_workspace: 400, no_session: 400,
  invalid_args: 400, no_match: 422, not_unique: 422, binary_file: 422, skill_not_found: 404,
  is_directory: 400, not_a_directory: 400, too_large: 413, credential_required: 400, search_failed: 502,
  busy: 409, container_start_failed: 503, container_unavailable: 503, exec_timeout: 504, not_ready: 409, interrupted: 499,
};

const clientOf = (req: { headers: Record<string, unknown> }): string => {
  const header = req.headers['x-phantom-client'];
  return typeof header === 'string' ? header : '';
};

/** The session a tool call or listing names: known and still active, with
 *  its project. A tool call is use — the checkout is touched. Files are
 *  NOT required here: a tool that needs them asks `files()`, which refuses a
 *  session without a workspace. */
async function sessionOf(ctx: PhantomBackend, id: string): Promise<{ session: SessionRow; project: ProjectRow }> {
  if (!id) throw new ToolError('session_not_found', `missing ${SESSION_HEADER} header`);
  const session = await ctx.sessions.get(id);
  if (!session) throw new ToolError('session_not_found', `no session ${id}`);
  if (session.status !== 'active') throw new ToolError('session_destroyed', `session is ${session.status}`);
  const project = await ctx.projects.get(session.projectId);
  if (!project) throw new ToolError('not_found', 'project vanished');
  void ctx.sessions.touch(session);
  return { session, project };
}

export function toolRoutes(app: FastifyInstance, ctx: PhantomBackend) {
  const send = (reply: { code: (status: number) => { send: (b: unknown) => unknown } }, error: unknown) => {
    if (error instanceof ToolError) return reply.code(STATUS[error.code] ?? 400).send(err(error.code, error.message, error.retryable, error.detail));
    throw error;
  };

  // One route per tool, registered from the same objects the listing
  // publishes — validation and documentation cannot drift from the contract.
  for (const def of TOOLS) {
    app.post<{ Body: Record<string, unknown> }>(`/tools/${def.name}`, {
      schema: {
        tags: ['tools'],
        summary: def.summary,
        // The tool's own description — the very text the agent reads — so the
        // docs show exactly what agents are told.
        description: def.description + (def.mutates ? '\n\nThis tool can change files or state.' : '\n\nThis tool only reads.'),
        headers: {
          type: 'object',
          properties: { [SESSION_HEADER]: { type: 'string', description: 'The session the tool runs in.' } },
        },
        body: def.input,
      },
    }, async (req, reply) => {
      try {
        const { session, project } = await sessionOf(ctx, String(req.headers[SESSION_HEADER] ?? ''));
        // The client aborting its fetch surfaces as the socket closing with
        // the reply unfinished — the one reliable disconnect signal
        // (onRequestAbort keys off req.aborted, dead since Node 16: it never
        // fires once the JSON body has been read). On normal completion
        // writableFinished is true and nothing aborts.
        const abort = new AbortController();
        reply.raw.on('close', () => { if (!reply.raw.writableFinished) abort.abort(); });
        let files: Promise<FileTools> | undefined;
        const toolCtx: ToolCtx = {
          app: ctx, session, project, client: clientOf(req), signal: abort.signal,
          files: () => {
            if (!files) {
              if (!session.workspaceId) throw new ToolError('no_workspace', 'this session has no files — nothing to read');
              files = fileTools(ctx, fsDeps(ctx), session, session.workspaceId, abort.signal);
            }
            return files;
          },
        };
        return ok(await def.execute(toolCtx, req.body ?? {}));
      } catch (error) { return send(reply, error); }
    });
  }
}
