// Tools — every tool defined once, in a group; published per agent type
// (the type's groups, minus what the session cannot have: no files → no
// file tools, feature off → no tool); run by name for a session. The
// SDK's tools and user space's (config.tools) are one list. Stub.
import type { ToolDefinition, ToolGroup } from '../doors.js';

export interface PublishedTool { name: string; summary: string; description?: string; input: Record<string, unknown>; mutates: boolean }
export interface ToolEnvelope { ok: boolean; data?: unknown; error?: { code: string; message: string; retryable: boolean; detail?: unknown } }

export class Tools {
  register(definitions: ToolDefinition[]): void { throw stub(); }
  get(name: string): ToolDefinition | undefined { throw stub(); }
  groups(): ToolGroup[] { throw stub(); }
  /** The tools a session of `type` has right now. */
  async publishFor(type: string, sessionId: string): Promise<PublishedTool[]> { throw stub(); }
  /** Run one for a session. The envelope IS the answer; a thrown ToolError becomes its error. */
  async run(name: string, sessionId: string, args: unknown, signal?: AbortSignal): Promise<ToolEnvelope> { throw stub(); }
}
const stub = () => new Error('stub');
