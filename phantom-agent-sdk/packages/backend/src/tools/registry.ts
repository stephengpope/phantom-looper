// The tool surface: every tool an agent can call, defined ONCE (one file per
// area: files, board, crons, skills, web, secrets, database, git, notify, media) and
// served two ways from the same objects — GET /agents/:agent/tools?session=
// publishes what an agent of that kind has on that session right now, and
// POST /tools/:name runs one. A client builds its tools from the listing and
// never holds a definition of its own; which agent gets which tool, and
// whether a tool exists at all (a feature switched off is a missing tool),
// is decided here and nowhere else.
import type { OfferCtx, PublishedTool, ToolDef } from './def.js';
import { FILE_TOOLS } from './files.js';
import { BOARD_TOOLS } from './board.js';
import { CRON_TOOLS } from './crons.js';
import { SKILL_TOOLS } from './skills.js';
import { WEB_TOOLS } from './web.js';
import { SECRET_TOOLS } from './secrets.js';
import { DATABASE_TOOLS } from './database.js';
import { NOTIFY_TOOLS } from './notify.js';
import { GIT_TOOLS } from './git.js';
import { MEDIA_TOOLS } from './media.js';

/** The SDK's own tools. User space's join them through `registerTools`. */
export const TOOLS: ToolDef[] = [
  ...FILE_TOOLS, ...SKILL_TOOLS, ...WEB_TOOLS, ...SECRET_TOOLS, ...CRON_TOOLS,
  ...DATABASE_TOOLS, ...BOARD_TOOLS, ...NOTIFY_TOOLS, ...GIT_TOOLS, ...MEDIA_TOOLS,
];

export const toolByName = new Map(TOOLS.map((tool) => [tool.name, tool]));

/** Add tools user space serves from the backend (config.tools). A name
 *  already taken is an error — one definition per tool. */
export function registerTools(definitions: readonly ToolDef[]): void {
  for (const definition of definitions) {
    if (toolByName.has(definition.name)) throw new Error(`tool '${definition.name}' is defined twice`);
    TOOLS.push(definition);
    toolByName.set(definition.name, definition);
  }
}

const dupes = TOOLS.map((tool) => tool.name).filter((name, i, a) => a.indexOf(name) !== i);
if (dupes.length) throw new Error(`tool names defined twice: ${dupes.join(', ')}`);

/** The tool names a type's grants name: a grant is a tool name, a group
 *  (every tool of it), or `group:read` (its non-mutating tools). */
export function grantedTools(grants: readonly string[]): ToolDef[] {
  const names = new Set<string>();
  for (const grant of grants) {
    const [group, mode] = grant.split(':');
    for (const tool of TOOLS) {
      if (tool.name === grant) names.add(tool.name);
      else if (tool.group === group && (mode === undefined || (mode === 'read' && !tool.mutates))) names.add(tool.name);
    }
  }
  return TOOLS.filter((tool) => names.has(tool.name));
}

/** The tools a session of `type` has right now: the type's grants, minus
 *  what the session cannot have (no files → no file tools, a feature off). */
export async function toolsFor(type: string, ctx: OfferCtx): Promise<PublishedTool[]> {
  const out: PublishedTool[] = [];
  for (const tool of grantedTools(ctx.app.agentTypes.require(type).tools)) {
    if (tool.offered && !(await tool.offered(ctx))) continue;
    out.push({ name: tool.name, summary: tool.summary, description: tool.description, input: tool.input, mutates: tool.mutates });
  }
  return out;
}

export type { FileTools, OfferCtx, PublishedTool, ToolCtx, ToolDef } from './def.js';
