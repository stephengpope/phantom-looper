// The extension doors: what user space registers through PhantomBackendConfig.
// Each is a plain description; the backend builds the real thing from it.

/** One setting, completely: its default, its type, how a screen shows it,
 *  where it may be set, how a value is validated. The SDK registers its own
 *  this way at boot; user space's (config.settings) come in the same door
 *  and from then on nothing tells them apart. Defaults live in code — the
 *  table holds only overrides, so a new setting ships working with no
 *  migration and "unset" stays distinct from "set to the current default".
 *
 *  Null is never STORED: null in a write clears the key. A setting whose
 *  default is null is therefore the only kind that may be cleared to
 *  "nothing" ("no timeout", "no endpoint"); a nullable setting with a
 *  non-null default would make "off" unsayable, so the registry refuses it. */
export interface SettingDefinition {
  /** The identifier: what the API, a bug report and the table use. */
  key: string;
  default: unknown;
  type: 'string' | 'number' | 'boolean';
  /** The name a person reads, under its group heading (`coding_provider` is "provider" under "coding"). */
  label: string;
  /** What it does, in one or two plain sentences — and, where it matters,
   *  WHEN a change applies. Rendered verbatim by every client. */
  description: string;
  /** The heading a settings screen files this under — an agent type, or an area. */
  group: string;
  /** The sub-heading inside a group (model, compaction, voice). */
  subgroup?: string;
  /** Exhaustive legal values. Present => the client renders a picker. */
  choices?: readonly string[];
  /** What to call cryptic stored values on screen. The stored value is unchanged. */
  choiceLabels?: Readonly<Record<string, string>>;
  /** The values to offer for an open string — a field that filters this list as you type. Not a closed set: `check` refuses. */
  suggestions?: readonly string[];
  min?: number;
  max?: number;
  unit?: 'ms' | 'bytes' | 'mb' | 'count';
  /** Exact shape a string must take, where a closed list is too narrow. */
  pattern?: RegExp;
  /** A check no grammar can express (the value must name something that exists). Why it is refused, or null. */
  check?: (value: string) => string | null;
  /** May a project override it? Default false: a project differs only where that earns its keep. */
  projectOverridable?: boolean;
  /** A fact about ONE project (a card prefix names one board): never settable globally. Implies projectOverridable. */
  projectOnly?: boolean;
  /** Where it files on screen: right before this key's row, when that key is
   *  registered; otherwise at the end. Registration order is screen order,
   *  and user space's settings register last — this puts one among the
   *  SDK's where it belongs (a looper switch beside the board's prefix). */
  before?: string;
  /** A credential: stored encrypted, served masked, read only through `Settings.credential`. */
  secret?: boolean;
  /** For a credential: the LLM provider this key authenticates — the one
   *  declaration of which row holds which provider's key. */
  provider?: string;
  /** For a model or endpoint setting: the provider setting it belongs to.
   *  A project's own provider row, when it differs from the global one,
   *  cuts the global model/endpoint out of the chain — a project on openai
   *  must not inherit global's claude id. Also the PROVIDER-FIRST write
   *  rule: a project may set this only under its own provider row, and
   *  clearing the provider clears this with it. */
  boundToProvider?: string;
  /** For a model setting: unset, it resolves to the newest model the
   *  catalog lists for the bound provider, so it follows releases. */
  defaultsToLatestModel?: boolean;
}

/** The tool groups the SDK ships. A tool belongs to one; an agent type
 *  names the groups it gets. The SDK's tools never name an agent type. */
export type ToolGroup = 'files' | 'tasks' | 'skills' | 'web' | 'secrets' | 'crons' | 'database' | 'board' | 'git' | 'notify';
/** A whole group, or only its non-mutating tools (`files:read` = read, ls, find, grep). */
export type ToolGrant = ToolGroup | `${ToolGroup}:read`;

/** The ten settings every agent type carries — its model and its
 *  compaction — keyed by the suffix after `<name>_`. The SDK gives each its
 *  shape (type, label, choices, limits, what it is bound to); the type says
 *  what it MEANS to a person, its default, and whether a project may
 *  override it. No wording is the SDK's. */
export type AgentTypeSettingSuffix =
  | 'provider' | 'model' | 'base_url' | 'reasoning' | 'max_steps'
  | 'context_window' | 'compact_threshold_pct' | 'compact_strategy' | 'compact_summarize_pct' | 'compact_max_tokens';
export interface AgentTypeSetting {
  description: string;
  /** Unset = null (clearable; for a type other than the first, "the first type's"). */
  default?: unknown;
  projectOverridable?: boolean;
}

/** An agent type this backend runs. The name is what sessions carry in
 *  `type`, what turn-start asks for, what the settings keys are prefixed
 *  with (`<name>_provider`, `<name>_model`, …). */
export interface AgentTypeDefinition {
  name: string;
  /** What each of its ten settings means, its default, its overridability. */
  settings: Record<AgentTypeSettingSuffix, AgentTypeSetting>;
  /** Which tool groups, whole or read-only, a session of this type is offered. */
  tools: ToolGrant[];
  /** Does a session of this type own a checkout, borrow another
   *  session's, or run with no files? Decides what POST /sessions makes. */
  workspace: 'own' | 'borrow' | 'none';
  /** Shown in session lists by default? (A supervisor's record is not.) */
  listed?: boolean;
}

/** A tool user space serves from the backend. Same shape as the SDK's own
 *  definitions; the backend publishes and runs it like any other. */
export interface ToolDefinition {
  name: string;
  group: ToolGroup | string;
  summary: string;
  description?: string;
  input: Record<string, unknown>;
  mutates: boolean;
  run(args: unknown, ctx: ToolRunContext): Promise<unknown>;
}

/** What a running tool is given: the session it runs for, and the backend. */
export interface ToolRunContext {
  sessionId: string;
  projectId: string;
  workspaceId: string | null;
  backend: unknown;   // PhantomBackend — typed when the stub becomes real
}

/** User space's routes: called with the Fastify instance after the SDK's
 *  routes and auth are in place. */
export type RouteRegistrar = (api: unknown /* FastifyInstance */) => void | Promise<void>;
