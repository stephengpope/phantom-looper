// AgentTypes — the registry of agent types this backend runs. The SDK ships
// none; user space registers its own (config.agentTypes). A type is a
// name, the tool grants its sessions get, how its sessions relate to a
// workspace, and when its sessions are listed. Every other object asks
// here instead of knowing a type by name. A type's model settings fall back
// to the type it names (`modelFallsBackTo`); a root falls back to nothing.
import type { AgentTypeDefinition, ToolGrant } from '../doors.js';

export class AgentTypesError extends Error {
  constructor(readonly code: 'unknown_agent_type' | 'duplicate_agent_type', message: string) { super(message); this.name = 'AgentTypesError'; }
}

export class AgentTypes {
  readonly #types = new Map<string, AgentTypeDefinition>();

  register(definitions: readonly AgentTypeDefinition[]): void {
    for (const definition of definitions) {
      if (this.#types.has(definition.name)) throw new AgentTypesError('duplicate_agent_type', `agent type '${definition.name}' is registered twice`);
      this.#types.set(definition.name, definition);
    }
    // Every fallback names a registered type, and following them ends at a root.
    for (const definition of definitions) {
      const seen = new Set<string>();
      for (let name: string | undefined = definition.name; name; name = this.#types.get(name)?.modelFallsBackTo) {
        if (seen.has(name)) throw new AgentTypesError('unknown_agent_type', `agent type '${definition.name}': modelFallsBackTo forms a cycle`);
        seen.add(name);
        if (!this.#types.has(name)) throw new AgentTypesError('unknown_agent_type', `agent type '${definition.name}' falls back to '${name}', which is not registered`);
      }
    }
  }

  get(name: string): AgentTypeDefinition | undefined { return this.#types.get(name); }
  has(name: string): boolean { return this.#types.has(name); }
  /** Throws `unknown_agent_type` — the one check every route does. */
  require(name: string): AgentTypeDefinition {
    const definition = this.#types.get(name);
    if (!definition) throw new AgentTypesError('unknown_agent_type', `no agent type named '${name}' — registered: ${this.names().join(', ') || '(none)'}`);
    return definition;
  }
  list(): AgentTypeDefinition[] { return [...this.#types.values()]; }
  names(): string[] { return [...this.#types.keys()]; }
  /** The type `name` falls back to, or null for a root. */
  fallbackOf(name: string): string | null { return this.require(name).modelFallsBackTo ?? null; }
  toolGrantsOf(name: string): ToolGrant[] { return this.require(name).tools; }
  /** The types whose sessions a list shows: the `always` ones, plus the
   *  `background` ones when the caller asks for background sessions. */
  listedNames(opts: { background: boolean }): string[] {
    return this.list()
      .filter((definition) => (definition.listed ?? 'always') === 'always' || (opts.background && definition.listed === 'background'))
      .map((definition) => definition.name);
  }
  /** Does a session of `name` own its checkout, borrow one, or run with none? */
  workspaceOf(name: string): AgentTypeDefinition['workspace'] { return this.require(name).workspace; }
}
