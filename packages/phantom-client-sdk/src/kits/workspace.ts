// The WORKSPACE kit — the file tools (bash read write edit ls find grep)
// plus the task tools (task_list task_wait task_kill). The definitions are
// the server's (GET /tools), fetched once per build; each becomes a tool
// that POSTs back with the session header. Which of them change things is
// the server's word too — each definition's `mutates` — never a list here.
// The version folds in the session's folder: a session that follows another
// (the assistant) reads that one's files, and its tools are rebuilt when it
// moves.
import { jsonSchema, tool, type Tool } from 'ai';
import { callRaw } from '../backend.js';
import { PhantomError } from '../errors.js';
import type { BuiltTools, ToolKit, ToolKitContext } from '../toolkit.js';

interface ToolListing {
  sessionHeader: string;
  tools: { name: string; summary: string; description?: string; input: Record<string, unknown>; mutates: boolean }[];
}

export const workspaceToolKit: ToolKit = {
  name: 'workspace',
  version: (ctx) => `${ctx.sessionId}:${ctx.folderId ?? ''}`,
  async build(ctx: ToolKitContext): Promise<BuiltTools> {
    const listing = await callRaw<ToolListing>(ctx.backend, 'GET', '/tools');
    if (!listing.ok || !listing.data) {
      throw new PhantomError('tool_build_failed', `could not read the tool list: ${listing.error?.message ?? 'no data'}`);
    }
    const out: Record<string, Tool> = {};
    for (const def of listing.data.tools) {
      out[def.name] = tool({
        description: def.description ?? def.summary,
        inputSchema: jsonSchema(def.input as never),
        // Image reads reach the model as an image, not a JSON blob of base64.
        toModelOutput: ({ output }) => {
          const img = (output as { data?: { image?: { media_type: string; base64: string } } })?.data?.image;
          if (img) {
            return { type: 'content', value: [{ type: 'file', mediaType: img.media_type, data: { type: 'data', data: img.base64 } }] } as never;
          }
          return { type: 'json', value: output as never };
        },
        // The abort signal rides into the request: an interrupt aborts it and
        // the server kills the running command's process group.
        execute: (args: unknown, opts?: { abortSignal?: AbortSignal }) =>
          // The envelope IS the result — errors included. The model reads
          // {ok:false, error:{code, message, retryable}} and self-corrects.
          callRaw(ctx.backend, 'POST', `/tools/${def.name}`, args ?? {}, { sessionId: ctx.sessionId, signal: opts?.abortSignal }),
      });
    }
    return { tools: out, mutating: listing.data.tools.filter((t) => t.mutates).map((t) => t.name) };
  },
};

/** The workspace kit with only the tools that look — for an agent that
 *  inspects and never writes (the supervisor, the assistant), whatever the
 *  readonly flag says. No folder (an assistant with nothing on screen) = no
 *  file tools, not a failing build. */
export const readonlyWorkspaceToolKit: ToolKit = {
  name: 'workspace',
  version: (ctx) => workspaceToolKit.version(ctx),
  async build(ctx: ToolKitContext): Promise<BuiltTools> {
    if (!ctx.folderId) return { tools: {}, mutating: [] };
    const { tools, mutating } = await workspaceToolKit.build(ctx);
    const writers = new Set(mutating);
    return { tools: Object.fromEntries(Object.entries(tools).filter(([n]) => !writers.has(n))), mutating: [] };
  },
};
