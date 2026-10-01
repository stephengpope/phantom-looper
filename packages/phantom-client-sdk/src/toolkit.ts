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
import type { PhantomBackend } from './backend.js';
import type { PublishedTool } from './session.js';

export interface ToolKitContext {
  backend: PhantomBackend;
  sessionId: string;
  projectId: string;
  /** The workspace the session's tools open. */
  workspaceId: string | null;
  readonly: () => boolean;
}

/** What a kit builds: its tools, and which of them change things. */
export interface BuiltTools {
  tools: Record<string, Tool>;
  /** Names from `tools` that change things. Refused while readonly. */
  mutating: readonly string[];
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
  for (const [name, t] of Object.entries(tools)) {
    if (!mutating.has(name) || !t.execute) { out[name] = t; continue; }
    const inner = t.execute;
    out[name] = { ...t, execute: (args: unknown, opts: unknown) =>
      ctx.readonly() ? readonlyRefusal(name) : (inner as (a: unknown, o: unknown) => unknown)(args, opts) };
  }
  return out;
}

/** An agent's kits, built together before a turn. */
export class ToolKitSet {
  private kits = new Map<string, ToolKit>();

  add(kit: ToolKit): void { this.kits.set(kit.name, kit); }

  async resolve(ctx: ToolKitContext): Promise<Record<string, Tool>> {
    const all: Record<string, Tool> = {};
    for (const kit of this.kits.values()) Object.assign(all, guardReadonly(await kit.build(ctx), ctx));
    return all;
  }
}

// ── the server's tools ────────────────────────────────────────────────────

/** The server's tools for this turn, from the listing turn-start answered:
 *  the server's word on which tools the agent has right now (a switched-off
 *  feature is a missing tool, a session with no files has no file tools)
 *  and what each one does. Each becomes a tool that POSTs back with the
 *  session header; the envelope IS the result — the model reads
 *  {ok:false, error:{code, message, retryable}} and self-corrects. */
export function serverToolKit(listing: readonly PublishedTool[]): ToolKit {
  return {
    name: 'server',
    build(ctx: ToolKitContext): Promise<BuiltTools> {
      const out: Record<string, Tool> = {};
      for (const def of listing) {
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
          // the server stops what the tool was doing.
          execute: (args: unknown, opts?: { abortSignal?: AbortSignal }) =>
            ctx.backend.callRaw('POST', `/tools/${def.name}`, args ?? {}, { sessionId: ctx.sessionId, signal: opts?.abortSignal }),
        });
      }
      return Promise.resolve({ tools: out, mutating: listing.filter((t) => t.mutates).map((t) => t.name) });
    },
  };
}
