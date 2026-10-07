// The shape every tool definition has, and the schema helpers the
// definition files share. The list itself is registry.ts.
import type { PhantomBackend } from '../PhantomBackend.js';
import type { SessionRow, ProjectRow } from '../storage/schema.js';
import type { Sandbox } from '../runtime/Sandbox.js';
import { ToolError } from './envelope.js';
import type { ToolGroup } from '../doors.js';

/** What a tool call runs with: the row owners, the calling session and its
 *  project, who called (the lock identity), the client's abort, and the
 *  session's files — started on first use, so a tool that never touches a
 *  file never starts a container. */
export interface ToolCtx {
  app: PhantomBackend;
  session: SessionRow;
  project: ProjectRow;
  /** The caller's x-phantom-client — rides card writes as the writer. */
  client: string;
  signal: AbortSignal;
  files(): Promise<FileTools>;
}

/** The session's container and the bash/task plumbing the route layer wires
 *  around it (api/routes/fs.ts) — the registry stays free of db and docker. */
export interface FileTools {
  sandbox: Sandbox;
  limits: { maxReadBytes: number; maxSearchResults: number };
  runBash: (args: { cmd: string; cwd?: string; detached?: boolean; timeout?: number }) => Promise<unknown>;
  tasks: {
    list: () => Promise<unknown>;
    wait: (backgroundTaskId: string, timeoutMs: number) => Promise<unknown>;
    kill: (backgroundTaskId: string) => Promise<unknown>;
  };
}

/** What deciding whether a tool is offered may look at. */
export interface OfferCtx { app: PhantomBackend; session: SessionRow; project: ProjectRow }

export interface ToolDef {
  name: string;
  summary: string;
  description: string;
  input: Record<string, unknown>;   // JSON Schema
  /** Changes things. A client refuses it while its agent is read-only. */
  mutates: boolean;
  /** The area it belongs to — what a type grants whole or read-only. */
  group: ToolGroup;
  /** Whether it exists right now for this session (a setting, a workspace).
   *  Absent = always, for the types granted it. */
  offered?: (ctx: OfferCtx) => Promise<boolean>;
  execute: (ctx: ToolCtx, args: Record<string, unknown>) => Promise<unknown>;
}

/** What GET /agents/:agent/tools publishes per tool — the definition without
 *  its handler. */
export type PublishedTool = Pick<ToolDef, 'name' | 'summary' | 'description' | 'input' | 'mutates'>;

// ── schema helpers, shared by every definition file ────────────────────────

export const str = (description: string) => ({ type: 'string', description: description });
export const int = (description: string, def?: number) => ({ type: 'integer', description: description, ...(def !== undefined ? { default: def } : {}) });
export const bool = (description: string, def?: boolean) => ({ type: 'boolean', description: description, ...(def !== undefined ? { default: def } : {}) });
export const nullable = (type: string, description: string) => ({ type: [type, 'null'], description: description });
export const oneOf = (values: readonly string[], description: string) => ({ type: 'string', enum: [...values], description: description });
export const obj = (props: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties: props, required, additionalProperties: false,
});

export function s(value: unknown): string {
  if (typeof value !== 'string') throw new ToolError('invalid_args', 'expected a string');
  return value;
}

/** A refusal the model reads: thrown, the route answers the envelope
 *  {ok:false, error:{code, message}} — the same shape every tool speaks. */
export const refusal = (code: string, message: string, detail?: unknown) => new ToolError(code, message, false, detail);

