// The tool surface: every tool an agent can call, defined ONCE (one file per
// area: files, board, crons, skills, web, secrets, database, git, notify) and
// served two ways from the same objects — GET /agents/:agent/tools?session=
// publishes what an agent of that kind has on that session right now, and
// POST /tools/:name runs one. A client builds its tools from the listing and
// never holds a definition of its own; which agent gets which tool, and
// whether a tool exists at all (a feature switched off is a missing tool),
// is decided here and nowhere else.
import type { AgentName, OfferCtx, PublishedTool, ToolDef } from './def.js';
import { FILE_TOOLS } from './files.js';
import { BOARD_TOOLS } from './board.js';
import { CRON_TOOLS } from './crons.js';
import { SKILL_TOOLS } from './skills.js';
import { WEB_TOOLS } from './web.js';
import { SECRET_TOOLS } from './secrets.js';
import { DATABASE_TOOLS } from './database.js';
import { GIT_TOOLS } from './git.js';
import { NOTIFY_TOOLS } from './notify.js';

export const TOOLS: ToolDef[] = [
  ...FILE_TOOLS, ...SKILL_TOOLS, ...WEB_TOOLS, ...SECRET_TOOLS, ...CRON_TOOLS,
  ...DATABASE_TOOLS, ...BOARD_TOOLS, ...GIT_TOOLS, ...NOTIFY_TOOLS,
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));

const dupes = TOOLS.map((t) => t.name).filter((n, i, a) => a.indexOf(n) !== i);
if (dupes.length) throw new Error(`tool names defined twice: ${dupes.join(', ')}`);

/** The tools an agent of `agent` has on this session right now. */
export async function toolsFor(agent: AgentName, ctx: OfferCtx): Promise<PublishedTool[]> {
  const out: PublishedTool[] = [];
  for (const t of TOOLS) {
    if (!t.agents.includes(agent)) continue;
    if (t.offered && !(await t.offered(ctx))) continue;
    out.push({ name: t.name, summary: t.summary, description: t.description, input: t.input, mutates: t.mutates });
  }
  return out;
}

export type { AgentName, FileTools, OfferCtx, PublishedTool, ToolCtx, ToolDef } from './def.js';
