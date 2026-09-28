// A ToolKit is one group of tools. The runtime carries ONE kit of its own:
// the server's tools for this agent (`serverToolKit`, GET
// /agents/:type/tools?session=) — the server decides what an agent of that
// type gets, and what each tool does. An app adds tools only it can serve
// (its own screen, its own approvals) through the same interface with
// `agent.use(kit)`.
//
// `version()` is cheap and is asked before every turn: a kit's tools are
// rebuilt only when its version changes; a kit without one is rebuilt every
// turn. `build` answers the tools AND which of them change things — the kit
// that knows says so (the server kit reads it off each definition's
// `mutates`). `readonly` is asked at EXECUTE time: a mutating tool called
// while it says true answers the model with { ok:false, error:{ code:
// 'readonly' } } and runs nothing.
import { jsonSchema, tool, type Tool } from 'ai';
import type { PhantomBackend } from './backend.js';
import { PhantomError } from './errors.js';

export interface ToolKitContext {
  backend: PhantomBackend;
  sessionId: string;
  workspaceId: string;
  /** The folder the session's tools open — changes when a session is
   *  pointed at another's files. Kits whose tools depend on it fold it into
   *  their version. */
  folderId: string | null;
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
  /** Cheap. A different string = rebuild. Absent = rebuilt every turn. */
  version?(ctx: ToolKitContext): string;
  build(ctx: ToolKitContext): Promise<BuiltTools>;
}

/** What a refused tool answers the model: a coded error, plain words. */
export const readonlyRefusal = (name: string) => ({
  ok: false, error: { code: 'readonly', retryable: false, message: `refused: ${name} is off while this agent is read-only` },
});

/** Wrap built tools so the mutating ones ask `readonly()` at execute time. */
export function guardReadonly(built: BuiltTools, ctx: ToolKitContext): Record<string, Tool> {
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

/** The per-agent cache: rebuilds a kit only when its version moved. */
export class ToolKitSet {
  private kits = new Map<string, ToolKit>();
  private built = new Map<string, { version: string; tools: Record<string, Tool> }>();

  add(kit: ToolKit): void {
    this.kits.set(kit.name, kit);
    this.built.delete(kit.name);
  }

  async resolve(ctx: ToolKitContext): Promise<Record<string, Tool>> {
    const all: Record<string, Tool> = {};
    for (const kit of this.kits.values()) {
      const version = kit.version?.(ctx);
      let entry = this.built.get(kit.name);
      if (!entry || version === undefined || entry.version !== version) {
        entry = { version: version ?? '', tools: guardReadonly(await kit.build(ctx), ctx) };
        this.built.set(kit.name, entry);
      }
      Object.assign(all, entry.tools);
    }
    return all;
  }
}

// ── the server's tools ────────────────────────────────────────────────────

interface ToolListing {
  tools: { name: string; summary: string; description?: string; input: Record<string, unknown>; mutates: boolean }[];
}

/** The server's tools for an agent of `type` on this session, read before
 *  every turn: the server's word on which tools that agent has right now
 *  (a switched-off feature is a missing tool, a session with no files has no
 *  file tools) and what each one does. Each becomes a tool that POSTs back
 *  with the session header; the envelope IS the result — the model reads
 *  {ok:false, error:{code, message, retryable}} and self-corrects. */
export function serverToolKit(type: string): ToolKit {
  return {
    name: 'server',
    async build(ctx: ToolKitContext): Promise<BuiltTools> {
      let listing: ToolListing;
      try {
        listing = await ctx.backend.call<ToolListing>('GET', `/agents/${encodeURIComponent(type)}/tools?session=${encodeURIComponent(ctx.sessionId)}`);
      } catch (e) {
        throw new PhantomError('tool_build_failed', `could not read the tool list: ${(e as Error).message}`, { cause: e });
      }
      const out: Record<string, Tool> = {};
      for (const def of listing.tools) {
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
      return { tools: out, mutating: listing.tools.filter((t) => t.mutates).map((t) => t.name) };
    },
  };
}
