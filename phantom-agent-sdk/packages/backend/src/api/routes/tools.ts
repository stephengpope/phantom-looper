// The tool routes — one surface for every tool an agent can call, off the
// registry (tools/registry.ts):
//
//   POST /sessions/:id/turn-start         what an agent of that type has on that
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
import { TOOL_CALL_HEADER } from '@phantom-agent-sdk/client';
import type { PhantomBackend } from '../../PhantomBackend.js';
import { SESSION_HEADER } from '../../agents/sessionHeader.js';
import { fileTools } from './fs.js';

const STATUS: Record<string, number> = {
  not_found: 404, session_not_found: 404, duplicate_name: 409, database_off: 409, database_unavailable: 503, telegram_unavailable: 503, sql_error: 400, session_destroyed: 410, no_workspace: 400, no_session: 400,
  invalid_args: 400, no_match: 422, not_unique: 422, binary_file: 422, skill_not_found: 404,
  is_directory: 400, not_a_directory: 400, too_large: 413, credential_required: 400, search_failed: 502,
  busy: 409, container_start_failed: 503, container_unavailable: 503, host_restarted: 503, exec_timeout: 504, not_ready: 409, interrupted: 499,
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
  /** A tool's failure as the envelope the model reads, with its status; a
   *  failure that is not a tool's own is thrown. */
  const refusal = (error: unknown): { status: number; body: ReturnType<typeof err> } => {
    if (error instanceof ToolError) return { status: STATUS[error.code] ?? 400, body: err(error.code, error.message, error.retryable, error.detail) };
    // The session runner the workspace is on came back as a new process: what
    // it was running is gone. Retryable — the agent runs the call again.
    if ((error as { code?: unknown }).code === 'host_restarted') return { status: 503, body: err('host_restarted', (error as Error).message, true) };
    throw error;
  };
  const send = (reply: { code: (status: number) => { send: (b: unknown) => unknown } }, error: unknown) => {
    const { status, body } = refusal(error);
    return reply.code(status).send(body);
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
      let end = () => undefined as void;
      try {
        const { session, project } = await sessionOf(ctx, String(req.headers[SESSION_HEADER] ?? ''));
        const client = clientOf(req);
        // The call's id, when the caller is an agent's turn: the api ran the
        // tool, so the api writes its result to the record (ToolCalls) and
        // hands the line back with the answer. A call with no id (a script
        // cron's bash) records its own.
        const toolCallId = typeof req.headers[TOOL_CALL_HEADER] === 'string' ? req.headers[TOOL_CALL_HEADER] : '';
        if (toolCallId) end = ctx.toolCalls.begin(session.id);
        // The client aborting its fetch surfaces as the socket closing with
        // the reply unfinished — the one reliable disconnect signal
        // (onRequestAbort keys off req.aborted, dead since Node 16: it never
        // fires once the JSON body has been read). On normal completion
        // writableFinished is true and nothing aborts. A hang-up stops the
        // tool only while the caller still HOLDS the session: a hold that
        // moved (a hand-off mid call) means the turn went on without it, and
        // the tool runs to its end for the next driver.
        const abort = new AbortController();
        reply.raw.on('close', () => {
          if (reply.raw.writableFinished) return;
          void ctx.sessions.get(session.id).then(
            (now) => { if (!now || !toolCallId || now.lockedBy === client) abort.abort(); },
            () => abort.abort());
        });
        let files: Promise<FileTools> | undefined;
        const toolCtx: ToolCtx = {
          app: ctx, session, project, client, signal: abort.signal,
          files: () => {
            if (!files) {
              if (!session.workspaceId) throw new ToolError('no_workspace', 'this session has no files — nothing to read');
              files = fileTools(ctx, session, session.workspaceId, abort.signal);
            }
            return files;
          },
        };
        let status = 200;
        let envelope: ReturnType<typeof ok> | ReturnType<typeof err>;
        try { envelope = ok(await def.execute(toolCtx, req.body ?? {})); }
        catch (error) { ({ status, body: envelope } = refusal(error)); }
        // The result is the record's — unless the call was cut (an interrupt,
        // a hang-up by the holder): a cut call has no result, and the driver
        // writes the placeholder for it.
        const written = toolCallId && !abort.signal.aborted
          ? await ctx.toolCalls.record(session.id, client, { toolCallId, toolName: def.name, input: req.body ?? {} }, envelope)
          : null;
        end();
        return reply.code(status).send(written ? { ...envelope, record: written } : envelope);
      } catch (error) { end(); return send(reply, error); }
    });
  }
}
