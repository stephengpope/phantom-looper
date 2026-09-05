/**
 * The TUI kit — tools that act on the running TUI window. Needs: the TUI's
 * live state (its open-session list), which exists nowhere else; the window
 * plugs its handler in at start. Only agents living in the TUI can carry this
 * kit (the Assistant does; the coding agent carries the kanban tool).
 *
 * Tool families, hermes-style domain-first names: `session_*` (the
 * Assistant's), and `kanban_*` in two builds — one board, two jobs:
 * `assistantKanbanTool` (cards + the screen: `kanban_board_*`,
 * `kanban_card_open/close`) and `codingKanbanTool` (`kanban_card_*` only).
 * Each tool passes its fixed action into the one handler, so both builds run
 * App's kanbanOps() over the same BoardStore exactly as before.
 */
import { tool, type ModelMessage, type Tool } from 'ai';
import { z } from 'zod';
import { DEFAULT_COLUMNS } from '../../kanban.js';

/** `status` is an ENUM of the real column names — the model cannot send
 *  "in progress" for in_progress. Pass the workspace's columns when they
 *  differ from the default; an empty list falls back to a plain string. */
const statusEnum = (columns: string[]) =>
  columns.length ? z.enum(columns as [string, ...string[]]) : z.string();

export interface SessionsArgs {
  action: 'list' | 'switch' | 'read' | 'get_active' | 'close';
  id?: string;
  limit?: number; offset?: number; tools?: boolean;
}

/** The `session_*` family: list every coding session, put one on screen,
 *  read one's conversation, or close one. Schemas and descriptions live here,
 *  whole; the TUI supplies the one handler; each tool passes its fixed action.
 *
 *  Where each answer comes from is deliberate. LIST is the SERVER's — the
 *  window only knows the sessions you happened to open in it, so a list built
 *  from memory says "one session" while the workspace holds fifty. SWITCH goes
 *  through the app's one open-a-session path, the same one /resume uses, so
 *  any session can be put on screen. READ stays on the window's memory: it
 *  renders the conversation the window is holding, and switch is what puts a
 *  conversation there. GET_ACTIVE is the window's own fact (which session is on
 *  screen) plus that one session's row — one call where session_list was a
 *  whole page fetched to read a single field. CLOSE is the window's act too:
 *  the session leaves local memory through the app's one close path (the same
 *  one /close and [x] on /resume use); the server keeps everything. */
export function sessionsTool(handler: (args: SessionsArgs) => Promise<unknown>): Record<string, Tool> {
  return {
    session_list: tool({
      description: 'Every coding session on the server — not just the ones open in this window: id, title, ' +
        'workspace, card, which is on screen, and which are RUNNING a turn right now (here or on another ' +
        'machine). Newest activity first, 20 at a time; raise offset to page back through older ones. ' +
        'The rows carry what identifies a session to a person (its title, the last thing typed, its card) — ' +
        'match what the user described against those rather than asking them for an id. ' +
        'Call this first when asked about sessions, and before switch/read with an id — ids come from here, ' +
        'never from memory.',
      inputSchema: z.object({
        limit: z.number().int().optional().describe('sessions to return (default 50, max 100)'),
        offset: z.number().int().optional().describe('skip this many of the most recent sessions (default 0) — raise it to page backwards'),
      }),
      execute: async (args) => handler({ action: 'list', ...args }),
    }),
    session_get_active: tool({
      description: 'Which session is on screen right now: its id, title, workspace, and card. ' +
        'ONE session — the one the user is looking at — so ask this instead of session_list when the ' +
        'question is what is on screen, or before acting on "this session": it is the live answer, not ' +
        'what a session_list said earlier or what you remember. session_list is still where you get OTHER ' +
        "sessions' ids. session_get_mode says whether that session is in plan or code mode.",
      inputSchema: z.object({}),
      execute: async () => handler({ action: 'get_active' }),
    }),
    session_switch: tool({
      description: 'Put a session on screen by id — ANY session session_list returned, not only the ones ' +
        'already open in this window. Opening one is reading: it never blocks whoever is running it. A session ' +
        'that had ENDED is restarted (its files are re-fetched, its work is untouched) — say so when the result ' +
        'reports it. The id must be exact, copied from session_list; a partial id is not accepted. ' +
        'The result says what is on screen now — report that, never assume the switch took.',
      inputSchema: z.object({
        id: z.string().describe('session id, exactly as session_list gave it'),
      }),
      execute: async ({ id }) => handler({ action: 'switch', id }),
    }),
    session_read: tool({
      description: "Read a session's conversation — what the user and the coding agent said and did. " +
        'Use when asked what a session is doing or has done. Returns the newest slice oldest-first; ' +
        "raise offset to page back; tools:true only when the one-line results aren't enough. " +
        'Defaults to the session on screen. Reads only sessions OPEN in this window — for any other, ' +
        'session_switch opens it first.',
      inputSchema: z.object({
        id: z.string().optional().describe('session id (defaults to the one on screen)'),
        limit: z.number().int().optional().describe('messages to return (default 50)'),
        offset: z.number().int().optional().describe('skip this many of the most recent messages (default 0) — raise it to page backwards'),
        tools: z.boolean().optional().describe('true = full tool output; default one line each'),
      }),
      execute: async (args) => handler({ action: 'read', ...args }),
    }),
    session_close: tool({
      description: 'Closes a session by id, or the active session if id is left out, and removes it ' +
        'from local memory. The session still remains on the server — it can be reopened later with session_switch.',
      inputSchema: z.object({
        id: z.string().optional().describe('session id from session_list; omit for the active session'),
      }),
      execute: async ({ id }) => handler({ action: 'close', id }),
    }),
  };
}

/** Render a slice of a session's conversation for `read` — the compact view
 *  the Assistant gets. Conversation text whole; a tool call is one line
 *  (name + its main argument); a tool result is one line + its size unless
 *  `tools` asks for the whole output; thinking is dropped. The header carries
 *  the navigation: which slice of how many, oldest first. */
export function renderRead(
  sessionId: string, messages: ModelMessage[],
  opts: { limit?: number; offset?: number; tools?: boolean } = {},
): string {
  const total = messages.length;
  const limit = Math.max(1, opts.limit ?? 50);
  const offset = Math.max(0, opts.offset ?? 0);
  const end = Math.max(0, total - offset);
  const start = Math.max(0, end - limit);
  if (total === 0) return `session ${sessionId} — the conversation is empty`;
  if (end <= start) {
    return `session ${sessionId} — showing none of ${total} (offset ${offset} is past the start)`;
  }
  const header = `session ${sessionId} — showing ${start + 1}-${end} of ${total} · oldest first`;
  const lines: string[] = [header, ''];
  for (const m of messages.slice(start, end)) lines.push(...renderMessage(m, opts.tools === true));
  return lines.join('\n');
}

const oneLine = (s: string, max = 150): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/** The argument worth showing for a tool call — the command, the path, the
 *  query; failing those, the first string in the input. */
function mainArg(input: unknown): string {
  if (typeof input === 'string') return oneLine(input);
  if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>;
    for (const key of ['command', 'file_path', 'path', 'query', 'pattern']) {
      if (typeof o[key] === 'string') return oneLine(o[key] as string);
    }
    for (const v of Object.values(o)) if (typeof v === 'string') return oneLine(v);
    return oneLine(JSON.stringify(o));
  }
  return '';
}

const asText = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value) ?? '';

function renderMessage(m: ModelMessage, fullTools: boolean): string[] {
  if (m.role === 'user') {
    if (typeof m.content === 'string') return [`user: ${m.content}`];
    return m.content.map((p) => p.type === 'text' ? `user: ${p.text}` : `user: [${p.type}]`);
  }
  if (m.role === 'assistant') {
    if (typeof m.content === 'string') return [`assistant: ${m.content}`];
    const out: string[] = [];
    for (const p of m.content) {
      if (p.type === 'text' && p.text.trim()) out.push(`assistant: ${p.text}`);
      else if (p.type === 'tool-call') out.push(`ran ${p.toolName}: ${mainArg(p.input)}`);
      // thinking is dropped: read answers what happened, not what was thought
    }
    return out;
  }
  if (m.role === 'tool') {
    return m.content.map((p) => {
      if (p.type !== 'tool-result') return `result: [${p.type}]`;
      const text = asText((p.output as { value?: unknown } | undefined)?.value ?? p.output);
      if (fullTools) return `result: ${text}`;
      const size = text.length > 300 ? ` (${(text.length / 1000).toFixed(1)}kb)` : '';
      return `result${size}: ${oneLine(text)}`;
    });
  }
  return [];
}

export interface ItemOpArg { op: 'add' | 'edit' | 'remove' | 'tick'; key?: string; text?: string; done?: boolean }

export interface KanbanArgs {
  action: 'screen' | 'list' | 'read' | 'create' | 'update' | 'move' | 'history' | 'items';
  card?: number; limit?: number; show?: 'board' | 'column' | 'card' | 'off'; column?: string;
  title?: string; details?: string; user_story?: string;
  status?: string; blocked_reason?: string | null; archived?: boolean;
  auto_plan?: boolean | null; auto_build?: boolean | null; pinned?: boolean;
  requirements?: { key?: string; text: string; done?: boolean }[];
  ops?: ItemOpArg[];
}

// A requirement carries a permanent `key` (assigned by the server, shown by
// reads and write results) — kanban_card_items names items by it, so no item
// change can wipe the rest of the list the way a mis-sent whole-list send could.
const itemSchema = z.object({ text: z.string(), done: z.boolean().optional() });

/** The card FIELDS shared by both builds. The requirements list rides only on
 *  CREATE (writing the initial list — nothing exists to destroy); after that
 *  every item change goes through kanban_card_items, one item at a time. */
const cardFields = (columns: string[]) => ({
  title: z.string().optional(),
  details: z.string().optional(),
  user_story: z.string().optional(),
  status: statusEnum(columns).optional().describe('the column'),
  blocked_reason: z.string().nullable().optional(),
});
const createLists = {
  requirements: z.array(itemSchema).optional().describe('what must be true for the card to be done — done means VERIFIED, not written'),
};

const cardNo = z.number().int().describe('card number — PHA-7 is card 7');

/** `kanban_card_read`, in both builds: the whole card, checklist items with
 *  their keys — where an agent gets the keys for a card it did not just
 *  write. `extra` is the kit's own workflow line. */
const readTool = (handler: (args: KanbanArgs) => Promise<unknown>, extra: string) => tool({
  description: 'One whole card — user story, details, and the requirements list, each item with its key ' +
    '(the handle kanban_card_items takes). ' + extra,
  inputSchema: z.object({ card: cardNo }),
  execute: async ({ card }) => handler({ action: 'read', card }),
});

/** `kanban_card_items`, the same in both builds: THE tool for checklist
 *  changes — every op names one item by key, so nothing else can be touched. */
const itemsTool = (handler: (args: KanbanArgs) => Promise<unknown>) => tool({
  description: 'Change requirements on a card — add, edit (reword), remove, tick — each op touches ONE item, ' +
    'named by its key; the rest of the list cannot be touched. Keys come back from kanban_card_read and every ' +
    'write result — copy them from there, never invent one. add needs only text (the server assigns the key, ' +
    'returned in the result). Ops apply in order, all-or-nothing. THE way to change the list — there is no ' +
    'whole-list send. Tick done true means you VERIFIED it, not that you wrote code for it.',
  inputSchema: z.object({ card: cardNo,
    ops: z.array(z.object({
      op: z.enum(['add', 'edit', 'remove', 'tick']),
      key: z.string().optional().describe('the item — required for edit/remove/tick'),
      text: z.string().optional().describe('required for add; new wording for edit'),
      done: z.boolean().optional().describe('required for tick; optional starting state for add') })).min(1) }),
  execute: async ({ card, ops }) => handler({ action: 'items', card, ops }),
});

/** The looper's per-card switches, one tool per loop column. `state` maps
 *  straight onto the card's tri-state field (`inherit` = null — the workspace
 *  setting decides). A flip is a card write, so the server's looper re-judges
 *  the card at once: on + the matching column = the loop starts. */
const autoSwitchTool = (handler: (args: KanbanArgs) => Promise<unknown>,
  field: 'auto_plan' | 'auto_build', column: string, job: string) => tool({
  description: `The card's Auto ${field === 'auto_plan' ? 'plan' : 'build'} switch — whether the supervisor ${job} while the card sits in ${column}. ` +
    'on/off overrides the workspace setting for this card; inherit clears the override so the workspace setting decides. ' +
    `Turning it on while the card is in ${column} starts the looper on it at once; kanban_card_move puts it there. ` +
    'The result states the switch as it now stands — report that.',
  inputSchema: z.object({ card: cardNo,
    state: z.enum(['on', 'off', 'inherit']).describe('inherit = follow the workspace setting') }),
  execute: async ({ card, state }) =>
    handler({ action: 'update', card, [field]: state === 'inherit' ? null : state === 'on' }),
});

/** `kanban_card_history`, the same in both builds: the revision record a
 *  trigger keeps on every card change. */
const historyTool = (handler: (args: KanbanArgs) => Promise<unknown>) => tool({
  description: "List a card's past revisions, newest first. Each revision is {op, changed, changed_at}: " +
    'on an update, changed holds the old values of the fields that changed; on a delete, the whole ' +
    "card as it last stood. A deleted card's history is still readable — pass its card number.",
  inputSchema: z.object({ card: cardNo,
    limit: z.number().int().optional().describe('revisions to return (default 20, newest first)') }),
  execute: async (args) => handler({ action: 'history', ...args }),
});

/** `kanban_*` for the ASSISTANT: the task board of the workspace on screen —
 *  cards plus the screen (`kanban_screen`, a UI helper and nothing more).
 *  Same pattern as `session_*`: schemas and descriptions whole here, the TUI
 *  supplies the one handler — it edits the same board store the screen renders
 *  from, so an edit made here repaints the open board immediately. */
export function assistantKanbanTool(handler: (args: KanbanArgs) => Promise<unknown>,
  columns: string[] = DEFAULT_COLUMNS): Record<string, Tool> {
  const fields = cardFields(columns);
  return {
    kanban_screen: tool({
      description: "UI helper: control what is on the USER's screen — the board, one column expanded to the full " +
        "width (for reading long titles), one card's editor, or none of them (back to chat). Changes the screen " +
        'only, reads nothing: use kanban_card_read to see a card yourself. ' +
        'The result says what is on screen now — report that, never guess.',
      inputSchema: z.object({
        show: z.enum(['board', 'column', 'card', 'off']).describe('board = every column; column = ONE column across the ' +
          'whole width; card = one card\'s editor (board behind it); off = back to chat'),
        card: cardNo.optional().describe('required when show is card'),
        column: statusEnum(columns).optional().describe('required when show is column') }),
      execute: async ({ show, card, column }) => handler({ action: 'screen', show, card, column }),
    }),
    kanban_card_list: tool({
      description: 'Every column and card (number, title, status) — a card is what people also call an issue, ' +
        'task, todo, or ticket. Cards are numbered — PHA-7 is card 7. ' +
        'Call before referring to cards by number; numbers come from here, never invented.',
      inputSchema: z.object({}),
      execute: async () => handler({ action: 'list' }),
    }),
    kanban_card_read: readTool(handler,
      'Read a card before changing items on one you did not just write — the keys come from here. ' +
      'Reading is yours alone; kanban_screen is for showing the card to the USER.'),
    kanban_card_create: tool({
      description: 'Make a new card from title; status picks the column (defaults to the first); the requirements ' +
        'list may ride along whole here — after creation it changes through kanban_card_items only. ' +
        'When asked to define a card, ask about what is unclear; never invent user_story or requirements.',
      inputSchema: z.object({ ...fields, ...createLists }),
      execute: async (args) => handler({ action: 'create', ...args } as KanbanArgs),
    }),
    kanban_card_update: tool({
      description: 'Change the card\'s FIELDS: title, story, details, column, blocked_reason (blocked means status ' +
        '"blocked"), archived true takes it off the board. Requirements are not fields — change those with kanban_card_items.',
      inputSchema: z.object({ card: cardNo, archived: z.boolean().optional(), ...fields }),
      execute: async (args) => handler({ action: 'update', ...args } as KanbanArgs),
    }),
    kanban_card_items: itemsTool(handler),
    kanban_card_auto_plan: autoSwitchTool(handler, 'auto_plan', 'plan',
      'plans it — has the coding agent write a plan, verifies it, and moves the card on'),
    kanban_card_auto_build: autoSwitchTool(handler, 'auto_build', 'in_progress',
      'builds it — drives the coding agent and verifies the work against the repo'),
    kanban_card_pin: tool({
      description: 'Pin or unpin a card. Pinned cards sit as a group at the top of their column ' +
        '(still sortable inside the group); unpinning drops the card back into the column\'s normal order. ' +
        'A plain on/off — pinning says nothing to the looper.',
      inputSchema: z.object({ card: cardNo, state: z.enum(['on', 'off']) }),
      execute: async ({ card, state }) => handler({ action: 'update', card, pinned: state === 'on' }),
    }),
    kanban_card_move: tool({
      description: 'Send card to the end of a status column.',
      inputSchema: z.object({ card: cardNo, status: statusEnum(columns).describe('the column to move to') }),
      execute: async (args) => handler({ action: 'move', ...args } as KanbanArgs),
    }),
    kanban_card_history: historyTool(handler),
  };
}

/** The mode pair (`session_get_mode`, `screen_enter_plan_mode`): a SESSION's
 *  plan/code mode — the row is the record, the handler reads it. Two modes
 *  exist — code mode (full tools) and plan mode (file tools read-only) — and an agent's
 *  switch is ONE WAY: only the user leaves plan mode (/plan). Carried by both
 *  in-window agents (the coding agent and the Assistant). Descriptions are
 *  STATIC — the kit never rewrites them per mode; the mode is a tool call
 *  away, never a memory. */
export interface ScreenModeHandler {
  getMode: () => Promise<unknown>;
  enterPlan: () => Promise<unknown>;
}

export function screenModeTools(handler: ScreenModeHandler): Record<string, Tool> {
  return {
    session_get_mode: tool({
      description: "The cli's current mode for the session on screen: plan mode (file tools " +
        'read-only) or code mode (full tools).',
      inputSchema: z.object({}),
      execute: async () => handler.getMode(),
    }),
    screen_enter_plan_mode: tool({
      description: 'Switch the cli to plan mode: the file tools become read-only. Use this when ' +
        'asked to plan something. The user returns the cli to code mode with /plan.',
      inputSchema: z.object({}),
      execute: async () => handler.enterPlan(),
    }),
  };
}

/** The spoken project name → the repo name: lowercase, every run of anything
 *  that is not a letter or digit becomes one hyphen ("Phantom Viewer" →
 *  phantom-viewer). Deterministic here, never the model's guess — the
 *  approval prompt shows exactly what this returns. */
export const kebabName = (s: string): string =>
  s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export interface WorkspaceCreateArgs { name: string; description?: string }

/** `workspace_create_repo`, the Assistant's start-a-new-project verb: a new
 *  PRIVATE GitHub repository + a workspace + a session on screen, one call
 *  (the backend's POST /workspaces create=true does the repo + the seed +
 *  the registration; the handler opens the session). GATED — the one tool
 *  that needs approval: the handler shows the user an accept/decline prompt
 *  with the FINAL name before anything exists on GitHub, because voice
 *  mishears names and a repo name is about to be permanent. Always private —
 *  visibility is not even a parameter the model could set. */
export function workspaceCreateTool(
  handler: (args: WorkspaceCreateArgs, opts: { abortSignal?: AbortSignal }) => Promise<unknown>,
): Record<string, Tool> {
  return {
    workspace_create_repo: tool({
      description: 'Start a NEW project: create a brand-new PRIVATE GitHub repository, register it as a ' +
        'workspace, and open a session in it, on screen. The repo name is the kebab-cased project name ' +
        '("phantom viewer" → phantom-viewer). Calling this shows the USER an accept/decline prompt with the ' +
        'final name — nothing is created until they accept (a click, a button, or saying "accept") — so tell ' +
        'them the prompt is up, then report the result. Declined usually means the name was misheard: ask what ' +
        'to change, then call again. Use the name the user gave — never invent one. Only for repos that do not ' +
        'exist yet; an existing repo is added in phantom-cli on the /workspace screen.',
      inputSchema: z.object({
        name: z.string().describe('the project name as the user said it — kebab-cased into the repo name'),
        description: z.string().optional().describe('one-line GitHub repo description, only when the user gave one'),
      }),
      execute: async (args, opts) => handler(args, { abortSignal: opts?.abortSignal }),
    }),
  };
}

export interface GitAutoPushArgs { id?: string }

/** `git_auto_push`, the Assistant's land-the-work verb — the same path as
 *  the cli's `/auto-push`: the session's branch (the one on screen unless an
 *  id is given) commits, merges base in, and fast-forwards base. The handler
 *  AWAITS the whole run so the result is the tool's answer; the steps land
 *  as notes in the session's conversation pane meanwhile, exactly as the
 *  command's do. Not gated: nothing is named or destroyed, and the branch
 *  stays on origin whatever happens to base. */
export function gitAutoPushTool(handler: (args: GitAutoPushArgs) => Promise<unknown>): Record<string, Tool> {
  return {
    git_auto_push: tool({
      description: "Land a session's work on the base branch — the same thing the cli's /auto-push does: " +
        'commit everything on the branch, merge the base branch in (the Git Fixer resolves conflicts), ' +
        'push the branch, then fast-forward base. Defaults to the session on screen. Runs to the end before ' +
        "answering — a conflict can take minutes — and the steps show as notes in the session's pane. " +
        'The answer is one of: pushed (with the commit), nothing (base already has it all), blocked, or error — ' +
        'report it in a sentence. Nothing pushes in the background; if the user has not asked to push, do not.',
      inputSchema: z.object({
        id: z.string().optional().describe('session id from session_list; omit for the session on screen'),
      }),
      execute: async (args) => handler(args),
    }),
  };
}

export interface GitAutoPullArgs { id?: string }

/** `git_auto_pull`, the Assistant's catch-up verb — the mirror of
 *  `git_auto_push`: the session's branch (the one on screen unless an id is
 *  given) takes the base branch IN. The handler AWAITS the whole run so the
 *  result is the tool's answer; in the cli the steps land as notes in the
 *  session's pane meanwhile. Not gated: nothing is named or destroyed, and
 *  nothing reaches base. */
export function gitAutoPullTool(handler: (args: GitAutoPullArgs) => Promise<unknown>): Record<string, Tool> {
  return {
    git_auto_pull: tool({
      description: "Bring the base branch into a session's branch — the reverse of git_auto_push: fetch origin, " +
        "commit the session's in-flight work, merge the base branch in (the Git Fixer resolves conflicts), " +
        'push the branch as a backup. Nothing reaches the base branch. Defaults to the session on screen. Runs ' +
        'to the end before answering — a conflict can take minutes. The answer is one of: merged (with the ' +
        'commits that arrived and the files they touched), clean (nothing to pull), blocked (a conflict left ' +
        'unresolved — the branch is as it was), or error — report it in a sentence. If the user has not asked ' +
        'to pull or sync, do not.',
      inputSchema: z.object({
        id: z.string().optional().describe('session id from session_list; omit for the session on screen'),
      }),
      execute: async (args) => handler(args),
    }),
  };
}

/** `kanban_card_*` for the CODING agent — one tool: reading the card it was
 *  pointed at ("do card 7" — also called an issue, task, todo, or ticket).
 *  User-directed: a task needs no card, so it does not go looking for one.
 *  Status moves and requirement ticks are not here — the kit defines what an
 *  agent can do; inside a loop run the looper adds `kanban_card_block`. */
export function codingKanbanTool(handler: (args: KanbanArgs) => Promise<unknown>,
  _columns: string[] = DEFAULT_COLUMNS): Record<string, Tool> {
  return {
    kanban_card_read: readTool(handler,
      'Read it before planning, and RE-read it when retrying or resuming — the card is the ' +
      'source of truth, not your memory of it. Cards are numbered: PHA-7 is card 7. ' +
      'Use the board only when the user points you at a card; a task needs no card.'),
  };
}
