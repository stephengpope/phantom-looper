// AgentTypes — the registry of agent types this server runs. The SDK ships
// none; user space registers its own (config.agentTypes). A type is a
// name, the tool groups its sessions get, how its sessions relate to a
// workspace, and whether its sessions are listed. Every other object asks
// here instead of knowing a type by name. Stub.
import type { AgentTypeDefinition, ToolGroup } from '../doors.js';

export class AgentTypes {
  register(definitions: AgentTypeDefinition[]): void { throw stub(); }
  get(name: string): AgentTypeDefinition | undefined { throw stub(); }
  /** Throws `unknown_agent_type` — the one check every route does. */
  require(name: string): AgentTypeDefinition { throw stub(); }
  list(): AgentTypeDefinition[] { throw stub(); }
  names(): string[] { throw stub(); }
  toolGroupsOf(name: string): ToolGroup[] { throw stub(); }
  /** The setting keys a type carries: `<name>_provider`, `<name>_model`,
   *  `<name>_base_url`, `<name>_reasoning`, `<name>_max_steps`. Registered
   *  into Settings for every type at boot. */
  settingKeysOf(name: string): string[] { throw stub(); }
}
const stub = () => new Error('stub');
