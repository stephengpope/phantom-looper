// A ToolKit is one group of tools. The runtime carries ONE kit of its own:
// the server's tools for this agent, listed with every turn start — the
// server decides what an agent of that type gets, and what each tool does.
// An app adds tools only it can serve (its own screen, its own approvals)
// through the same interface with `agent.addToolKit(kit)`.
//
// Every kit is built before every turn — what an agent has can change
// between turns (a setting, a workspace). `build` answers the tools AND which
// of them change things — the kit that knows says so (the server kit reads
// it off each definition's `mutates`). `readonly` is asked at EXECUTE time:
// a mutating tool called while it says true answers the model with
// { ok:false, error:{ code:'readonly' } } and runs nothing.
import { jsonSchema, tool, type Tool } from 'ai';
import type { BackendClient } from './backend.js';
import type { PublishedTool } from './session.js';
import type { TranscriptLine } from './transcript.js';

/** The header a server tool call carries its call id in: the api writes the
 *  result line under that id (api/routes/tools.ts). */
export const TOOL_CALL_HEADER = 'x-phantom-tool-call';

export interface ToolKitContext {
  backend: BackendClient;
  sessionId: string;
  projectId: string;
  /** The workspace the session's tools open. */
  workspaceId: string | null;
  readonly: () => boolean;
  /** The server wrote a record line for this turn (a server tool's result,
   *  handed back with the answer): file it. */
  recorded: (written: { line: TranscriptLine; lines: number; updated_at: string }) => void;
}

/** What a kit builds: its tools, and which of them change things. */
export interface BuiltTools {
  tools: Record<string, Tool>;
  /** Names from `tools` that change things. Refused while readonly. */
  mutating: readonly string[];
  /** Names from `tools` whose call ENDS the turn: the result lands, the
   *  record is written, and the model is not called again (a verdict, a
   *  hand-off). Absent = none. */
  terminal?: readonly string[];
  /** Names from `tools` whose results the SERVER writes to the record (it
   *  ran them): the turn files what comes back and writes nothing itself.
   *  Absent = the turn writes every result. */
  recordedByServer?: readonly string[];
}

export interface ToolKit {
  /** Unique among the agent's kits. Adding a kit with a name already present replaces it. */
  name: string;
  build(ctx: ToolKitContext): Promise<BuiltTools>;
}

/** What a refused tool answers the model: a coded error, plain words. */
const readonlyRefusal = (name: string) => ({
  ok: false, error: { code: 'readonly', retryable: false, message: `refused: ${name} is off while this agent is read-only` },
});

/** Wrap built tools so the mutating ones ask `readonly()` at execute time. */
function guardReadonly(built: BuiltTools, ctx: ToolKitContext): Record<string, Tool> {
  const { tools } = built;
  const mutating = new Set(built.mutating);
  const out: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!mutating.has(name) || !tool.execute) { out[name] = tool; continue; }
    const inner = tool.execute;
    out[name] = { ...tool, execute: (args: unknown, opts: unknown) =>
      ctx.readonly() ? readonlyRefusal(name) : (inner as (a: unknown, callOptions: unknown) => unknown)(args, opts) };
  }
  return out;
}

/** An agent's kits, built together before a turn. */
export class ToolKitSet {
  private kits = new Map<string, ToolKit>();

  add(kit: ToolKit): void { this.kits.set(kit.name, kit); }

  async resolve(ctx: ToolKitContext): Promise<{ tools: Record<string, Tool>; terminal: string[]; recordedByServer: Set<string> }> {
    const tools: Record<string, Tool> = {};
    const terminal: string[] = [];
    const recordedByServer = new Set<string>();
    for (const kit of this.kits.values()) {
      const built = await kit.build(ctx);
      Object.assign(tools, guardReadonly(built, ctx));
      terminal.push(...(built.terminal ?? []));
      for (const name of built.recordedByServer ?? []) recordedByServer.add(name);
    }
    return { tools, terminal, recordedByServer };
  }
}

// ── the server's tools ────────────────────────────────────────────────────

/** The server's tools for this turn, from the listing turn-start answered:
 *  the server's word on which tools the agent has right now (a switched-off
 *  feature is a missing tool, a session with no files has no file tools)
 *  and what each one does. Each becomes a tool that POSTs back with the
 *  session header and its call id; the envelope IS the result — the model
 *  reads {ok:false, error:{code, message, retryable}} and self-corrects.
 *  WHOEVER RUNS A TOOL WRITES ITS RESULT: the api ran it, so the api wrote
 *  the result line and hands it back with the answer; this side files it
 *  (ctx.recorded) and the turn writes nothing for it. */
export function serverToolKit(listing: readonly PublishedTool[]): ToolKit {
  return {
    name: 'server',
    build(ctx: ToolKitContext): Promise<BuiltTools> {
      const out: Record<string, Tool> = {};
      for (const def of listing) {
        out[def.name] = tool({
          description: def.description ?? def.summary,
          inputSchema: jsonSchema(def.input as never),
          // Image reads reach the model as an image, not a JSON blob of base64
          // — the same shaping the api wrote to the record (serverToolResultLine).
          toModelOutput: ({ output }) => {
            const img = (output as { data?: { image?: { media_type: string; base64: string } } })?.data?.image;
            if (img) {
              return { type: 'content', value: [{ type: 'file', mediaType: img.media_type, data: { type: 'data', data: img.base64 } }] } as never;
            }
            return { type: 'json', value: output as never };
          },
          // The abort signal rides into the request: an interrupt aborts it and
          // the server stops what the tool was doing. The answer carries the
          // record line the api wrote (`record`), filed here, never shown to the model.
          execute: async (args: unknown, opts?: { abortSignal?: AbortSignal; toolCallId?: string }) => {
            const answer = await ctx.backend.callRaw<unknown>('POST', `/tools/${def.name}`, args ?? {},
              { sessionId: ctx.sessionId, signal: opts?.abortSignal, headers: opts?.toolCallId ? { [TOOL_CALL_HEADER]: opts.toolCallId } : undefined });
            const { record, ...envelope } = answer as { record?: { line: TranscriptLine; lines: number; updated_at: string } } & Record<string, unknown>;
            if (record) ctx.recorded(record);
            return envelope;
          },
        });
      }
      return Promise.resolve({ tools: out, mutating: listing.filter((tool) => tool.mutates).map((tool) => tool.name),
        recordedByServer: listing.map((tool) => tool.name) });
    },
  };
}
