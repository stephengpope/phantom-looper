// A ToolKit is one group of tools. The package ships the default kits; a
// client adds its own (the cli's screen tools) through the same interface
// with `agent.use(kit)`.
//
// `version()` is cheap and the SDK calls it before every turn: a kit's
// tools are rebuilt only when its version changes. `build` answers the
// tools AND which of them change things — the kit that knows says so (the
// workspace kit reads it off the server's own tool list). `readonly` is
// asked at EXECUTE time: a mutating tool called while it says true answers
// the model with { ok:false, error:{ code:'readonly' } } and runs nothing.
import type { Tool } from 'ai';
import type { PhantomBackend } from './backend.js';

export interface ToolKitContext {
  backend: PhantomBackend;
  sessionId: string;
  workspaceId: string;
  /** The folder the session's tools open — changes when an assistant
   *  follows another session. Kits whose tools depend on it fold it into
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
  /** Cheap. A different string = rebuild. */
  version(ctx: ToolKitContext): string;
  build(ctx: ToolKitContext): Promise<BuiltTools>;
}

export const READONLY_REFUSAL = (name: string) => ({
  ok: false, error: { code: 'readonly', retryable: false,
    message: `in plan mode — ${name} is off until the user switches back to code mode` },
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
      ctx.readonly() ? READONLY_REFUSAL(name) : (inner as (a: unknown, o: unknown) => unknown)(args, opts) };
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
  remove(name: string): void { this.kits.delete(name); this.built.delete(name); }
  names(): string[] { return [...this.kits.keys()]; }

  async resolve(ctx: ToolKitContext): Promise<Record<string, Tool>> {
    const all: Record<string, Tool> = {};
    for (const kit of this.kits.values()) {
      const version = kit.version(ctx);
      let entry = this.built.get(kit.name);
      if (!entry || entry.version !== version) {
        entry = { version, tools: guardReadonly(await kit.build(ctx), ctx) };
        this.built.set(kit.name, entry);
      }
      Object.assign(all, entry.tools);
    }
    return all;
  }
}
