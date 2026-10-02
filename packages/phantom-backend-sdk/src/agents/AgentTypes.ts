// AgentTypes — the registry of agent types this backend runs. The SDK ships
// none; user space registers its own (config.agentTypes). A type is a
// name, the tool grants its sessions get, how its sessions relate to a
// workspace, and whether its sessions are listed. Every other object asks
// here instead of knowing a type by name. The FIRST registered type is the
// one the others' model settings fall back to (AgentConfig's cascade).
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
  /** The type the others fall back to: the first registered. */
  first(): string {
    const [first] = this.#types.keys();
    if (!first) throw new AgentTypesError('unknown_agent_type', 'no agent types are registered');
    return first;
  }
  toolGrantsOf(name: string): ToolGrant[] { return this.require(name).tools; }
  /** Only the sessions of these types appear in a default listing. */
  listedNames(): string[] { return this.list().filter((definition) => definition.listed !== false).map((definition) => definition.name); }
}
