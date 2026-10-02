// The extension doors: what user space registers through PhantomBackendConfig.
// Each is a plain description; the server builds the real thing from it.
// Stub: shapes only.

/** A setting user space adds. Served, resolved (default → global →
 *  project) and validated exactly like the SDK's own. */
export interface SettingDefinition {
  /** The key, e.g. `telegram_reply_mode`. Unique across SDK + user space. */
  key: string;
  default: unknown;
  type: 'string' | 'number' | 'boolean' | 'choice';
  label: string;
  description: string;
  /** The settings screen's group and optional sub-heading. */
  group: string;
  subgroup?: string;
  choices?: readonly string[];
  min?: number;
  unit?: 'ms' | 'count' | 'pct';
  /** May a project override it? Default true. */
  projectOverridable?: boolean;
  /** A credential: stored encrypted, served masked. */
  secret?: boolean;
}

/** The tool groups the SDK ships. A tool belongs to one; an agent type
 *  names the groups it gets. The SDK's tools never name an agent type. */
export type ToolGroup = 'files' | 'tasks' | 'skills' | 'web' | 'secrets' | 'crons' | 'database' | 'board' | 'git' | 'notify';

/** An agent type this server runs. The name is what sessions carry in
 *  `type`, what turn-start asks for, what the settings keys are prefixed
 *  with (`<name>_provider`, `<name>_model`, …). */
export interface AgentTypeDefinition {
  name: string;
  /** Which tool groups a session of this type is offered. */
  tools: ToolGroup[];
  /** Does a session of this type own a checkout, borrow another
   *  session's, or run with no files? Decides what POST /sessions makes. */
  workspace: 'own' | 'borrow' | 'none';
  /** Shown in session lists by default? (A supervisor's record is not.) */
  listed?: boolean;
}

/** A tool user space serves from the server. Same shape as the SDK's own
 *  definitions; the server publishes and runs it like any other. */
export interface ToolDefinition {
  name: string;
  group: ToolGroup | string;
  summary: string;
  description?: string;
  input: Record<string, unknown>;
  mutates: boolean;
  run(args: unknown, ctx: ToolRunContext): Promise<unknown>;
}

/** What a running tool is given: the session it runs for, and the server. */
export interface ToolRunContext {
  sessionId: string;
  projectId: string;
  workspaceId: string | null;
  server: unknown;   // PhantomBackend — typed when the stub becomes real
}

/** User space's routes: called with the Fastify instance after the SDK's
 *  routes and auth are in place. */
export type RouteRegistrar = (api: unknown /* FastifyInstance */) => void | Promise<void>;
