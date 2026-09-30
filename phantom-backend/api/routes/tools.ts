// The tool routes — one surface for every tool an agent can call, off the
// registry (tools/registry.ts):
//
//   GET  /agents/:agent/tools?session=   what an agent of that kind has on that
//                                        session right now — a client builds
//                                        its tools from this and nothing else
//   POST /tools/:name                    run one; the session travels in a
//                                        header, never in the schema the
//                                        model sees
//   GET  /tools                          the file tools' definitions, for the
//                                        clients that predate the agent
//                                        listing (core/llm/tools/workspace.ts)
//
// Tools take no lock — an agent fans out parallel calls in one turn and they
// all just run; the session/turn lock is the only lock.
import type { FastifyInstance } from 'fastify';
import type { SessionRow, WorkspaceRow } from '../../db/schema.js';
import { AGENT_NAMES, type AgentName } from '../../../core/llm/agentConfig.js';
import { TOOLS, toolsFor, type FileTools, type ToolCtx } from '../../tools/registry.js';
import { FILE_TOOLS } from '../../tools/files.js';
import { ToolError } from '../../tools/envelope.js';
import { ok, err, type AppCtx } from '../app.js';
import { SESSION_HEADER } from '../sessionHeader.js';
import { fileTools } from './fs.js';

const STATUS: Record<string, number> = {
  not_found: 404, session_not_found: 404, duplicate_name: 409, database_off: 409, database_unavailable: 503, telegram_unavailable: 503, sql_error: 400, session_destroyed: 410, no_folder: 400, no_session: 400,
  invalid_args: 400, no_match: 422, not_unique: 422, binary_file: 422, skill_not_found: 404,
  is_directory: 400, not_a_directory: 400, too_large: 413, credential_required: 400, search_failed: 502,
  busy: 409, container_start_failed: 503, container_unavailable: 503, exec_timeout: 504, not_ready: 409, interrupted: 499,
};

const clientOf = (req: { headers: Record<string, unknown> }): string => {
  const h = req.headers['x-phantom-looper-client'];
  return typeof h === 'string' ? h : '';
};

/** The session a tool call or listing names: known and still active, with
 *  its workspace. A tool call is use — the checkout is touched. Files are
 *  NOT required here: a tool that needs them asks `files()`, which refuses a
 *  session without a folder. */
async function sessionOf(ctx: AppCtx, id: string): Promise<{ session: SessionRow; workspace: WorkspaceRow }> {
  if (!id) throw new ToolError('session_not_found', `missing ${SESSION_HEADER} header`);
  const session = await ctx.sessions.get(id);
  if (!session) throw new ToolError('session_not_found', `no session ${id}`);
  if (session.status !== 'active') throw new ToolError('session_destroyed', `session is ${session.status}`);
  const workspace = await ctx.workspaces.get(session.workspaceId);
  if (!workspace) throw new ToolError('not_found', 'workspace vanished');
  void ctx.sessions.touch(session);
  return { session, workspace };
}

export function toolRoutes(app: FastifyInstance, ctx: AppCtx) {
  const send = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: unknown) => {
    if (e instanceof ToolError) return reply.code(STATUS[e.code] ?? 400).send(err(e.code, e.message, e.retryable, e.detail));
    throw e;
  };

  app.get<{ Params: { agent: string }; Querystring: { session: string } }>(
    '/agents/:agent/tools', { schema: { tags: ['tools'], summary: "An agent's tools on a session, right now",
      description: 'The tools an agent of this kind has on the session, as the server decides it at this moment: ' +
        'a switched-off feature is a missing tool, a session with no files has no file tools. Each carries name, ' +
        'summary, description, JSON Schema input and `mutates`. A client builds its tools from this list and runs ' +
        'them with POST /tools/:name under the session header.',
      params: { type: 'object', properties: { agent: { type: 'string', enum: [...AGENT_NAMES] } } },
      querystring: { type: 'object', required: ['session'], properties: { session: { type: 'string' } } } } },
    async (req, reply) => {
      try {
        const { session, workspace } = await sessionOf(ctx, req.query.session);
        return ok({ sessionHeader: SESSION_HEADER, tools: await toolsFor(req.params.agent as AgentName, { app: ctx, session, workspace }) });
      } catch (e) { return send(reply, e); }
    });

  // The file tools alone — the listing the earlier clients build from.
  app.get('/tools', { schema: { tags: ['tools'], summary: 'The file tool definitions',
    description: 'The file and task tools: name, summary, description, JSON Schema input, mutates, and the session ' +
      'header name. GET /agents/:agent/tools?session= is the whole picture for one agent.' } },
  async () => ok({
    version: '1',
    sessionHeader: SESSION_HEADER,
    tools: FILE_TOOLS.map(({ name, summary, description, input, mutates }) => ({ name, summary, description, input, mutates })),
  }));

  // One route per tool, registered from the same objects the listing
  // publishes — validation and documentation cannot drift from the contract.
  for (const def of TOOLS) {
    app.post<{ Body: Record<string, unknown> }>(`/tools/${def.name}`, {
      schema: {
        tags: ['tools'],
        summary: def.summary,
        description: def.description + (def.mutates ? ' Mutating.' : ' Read-only.'),
        headers: {
          type: 'object',
          properties: { [SESSION_HEADER]: { type: 'string', description: 'Session id (ULID). Required — enforced by the handler so the error speaks the envelope.' } },
        },
        body: def.input,
      },
    }, async (req, reply) => {
      try {
        const { session, workspace } = await sessionOf(ctx, String(req.headers[SESSION_HEADER] ?? ''));
        // The client aborting its fetch surfaces as the socket closing with
        // the reply unfinished — the one reliable disconnect signal
        // (onRequestAbort keys off req.aborted, dead since Node 16: it never
        // fires once the JSON body has been read). On normal completion
        // writableFinished is true and nothing aborts.
        const ac = new AbortController();
        reply.raw.on('close', () => { if (!reply.raw.writableFinished) ac.abort(); });
        let files: Promise<FileTools> | undefined;
        const toolCtx: ToolCtx = {
          app: ctx, session, workspace, client: clientOf(req), signal: ac.signal,
          files: () => {
            if (!files) {
              const fs = ctx.fs;
              if (!fs) throw new ToolError('container_unavailable', 'containers are not wired on this server', false);
              if (!session.folderId) throw new ToolError('no_folder', 'this session has no files — nothing to read');
              files = fileTools(ctx, fs, session, session.folderId, ac.signal);
            }
            return files;
          },
        };
        return ok(await def.execute(toolCtx, req.body ?? {}));
      } catch (e) { return send(reply, e); }
    });
  }
}
