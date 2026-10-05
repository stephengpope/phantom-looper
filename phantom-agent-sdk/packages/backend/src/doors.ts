// The extension doors: what user space registers through PhantomBackendConfig.
// Each is a plain description; the backend builds the real thing from it.
import type { Transaction } from './storage/Database.js';
import type { ProjectRow } from './storage/schema.js';

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

/** The area a tool belongs to — a label a type may grant whole (`files`)
 *  or read-only (`files:read` = its non-mutating tools) instead of naming
 *  every tool. The SDK's tools never name an agent type. */
export type ToolGroup = 'files' | 'tasks' | 'skills' | 'web' | 'secrets' | 'crons' | 'database' | 'board' | 'git' | 'notify';
/** What a type is granted: a tool by name (`kanban_card_read`), a whole
 *  group (`files`), or a group's read-only tools (`files:read`). Each agent
 *  is custom; name exactly what it gets. */
export type ToolGrant = string;

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
  /** The tools a session of this type is offered: names, or a group / group:read. */
  tools: ToolGrant[];
  /** Does a session of this type own a checkout, borrow another
   *  session's, or run with no files? Decides what POST /sessions makes. */
  workspace: 'own' | 'borrow' | 'none';
  /** When a session of this type appears in GET /sessions: `always` (the
   *  default), `background` (only when the caller asks for background
   *  sessions — a judge's record), `never` (tracked for tokens, never a row
   *  in a list — a helper the user talks to, not a work session). */
  listed?: 'always' | 'background' | 'never';
  /** The type whose model this one falls back to when its own provider /
   *  model / endpoint / reasoning / compaction are unset (the cascade,
   *  AgentConfig). Absent = a root: unset means empty, and the first model
   *  call says what to set. Must name a registered type; no cycles. */
  modelFallsBackTo?: string;
}

/** A tool user space serves from the backend: the same shape as the SDK's
 *  own definitions (tools/def.ts); the backend publishes and runs it like
 *  any other. */
export type { ToolDef as ToolDefinition, ToolCtx as ToolRunContext } from './tools/def.js';

/** User space's routes: called with the Fastify instance after the SDK's
 *  routes and auth are in place. */
export type RouteRegistrar = (api: unknown /* FastifyInstance */) => void | Promise<void>;

/** Fields an app keeps ABOUT a card in a table of its own, keyed by the
 *  card's id, and wants carried on every card the SDK answers — the board,
 *  a card, the tools, the board events — and accepted on create and PATCH
 *  under the same names, as if they were the card's. The SDK stores nothing
 *  of them and knows them only by the names declared here; it calls `read`
 *  on every card read and `write` inside its own write transaction, and
 *  records what `write` says the values were before as the card's history
 *  (card_revisions), so an app field's change is in the card's past like a
 *  column's. A card the app has no row for reads every field as null. */
export interface CardFieldsExtension {
  /** JSON Schema per field: what create and PATCH accept under the name. */
  schema: Record<string, Record<string, unknown>>;
  /** The fields of these cards, by card id; a card absent from the map has none set. */
  read(cardIds: number[]): Promise<Map<number, Record<string, unknown>>>;
  /** Write a card's fields inside the SDK's transaction; answers the values
   *  as they were before, for the fields that changed (empty = nothing changed). */
  write(cardId: number, fields: Record<string, unknown>, transaction: Transaction): Promise<Record<string, unknown>>;
  /** What rides the board payload beside the cards — a project's defaults
   *  for these fields, say. Absent = nothing. */
  board?(project: ProjectRow): Promise<Record<string, unknown>>;
}
