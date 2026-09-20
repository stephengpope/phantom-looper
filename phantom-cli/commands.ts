// Slash commands. A plain table so the menu, the matcher and the tests all read
// from one place — and so an unknown /command is an error the user sees rather
// than a message the model has to make sense of.
//
// A command may take the rest of the line as its argument (`/ask hello`). Only
// the first word is the command; while there is an argument the live menu
// stays out of the way, so enter sends the line rather than the highlighted row.
//
// Unless the argument is PICKED from a list (`/new <workspace>`): then the menu
// stays up and shows the list, filtered by what has been typed, and tab and
// the arrows work on it exactly as they do on the command names. The list is
// live (the window's workspaces), so the caller hands it in; this file only
// knows which commands take one.
export interface Command { name: string; summary: string; args?: string; picks?: boolean }
/** One row of a picked argument — the same two columns a command row has. */
export interface Choice { name: string; summary: string }
/** The live list for a command whose argument is picked. */
export type Choices = (command: Command) => Choice[];

export const COMMANDS: Command[] = [
  { name: 'new', summary: 'new session in this workspace, or /new <workspace>', args: 'workspace', picks: true },
  { name: 'resume', summary: 'reopen an earlier session' },
  { name: 'workspace', summary: 'start in a different workspace' },
  { name: 'kanban', summary: "this workspace's task board" },
  { name: 'tasks', summary: "what's running in this session's container" },
  { name: 'plan', summary: 'enter plan mode — the coding agent reads, nothing is written' },
  { name: 'code', summary: 'enter code mode — the coding agent has full tools' },
  { name: 'auto-push', summary: "push this session's work to the base branch" },
  { name: 'auto-pull', summary: "bring the base branch into this session's branch" },
  { name: 'model', summary: 'settings, at the coding agent' },
  { name: 'presets', summary: 'saved provider configurations — switch all agents at once' },
  // First row under the fold (the live menu shows MENU_ROWS = 8): closing a
  // session is a real everyday act, but not more everyday than the eight above
  // it, and [x] on /resume already teaches it.
  { name: 'compact', summary: 'compact this session, or /compact assistant', args: 'assistant' },
  { name: 'pop', summary: 'pull the last queued message into the prompt, or /pop all', args: 'all' },
  { name: 'duplicate', summary: 'duplicate this session — transcript, branch, model; /model or /presets moves the duplicate until its first message' },
  { name: 'close', summary: 'close this session — it stays on the server' },
  { name: 'trash', summary: 'trash this session for good — row, transcript, files' },
  { name: 'server', summary: 'the server url and api key, this machine only' },
  { name: 'cpu', summary: 'server status — cpu, load, memory, disk' },
  { name: 'tokens', summary: 'token usage — today, 7 days, 30 days; agents and helpers by model' },
  { name: 'restart', summary: 'restart the server, or one service (asks first)', args: 'service' },
  { name: 'settings', summary: "the server's settings, for everyone" },
  { name: 'keys', summary: 'the credentials the server holds' },
  { name: 'secrets', summary: "the coding agent's secrets — tokens it can read and use" },
  { name: 'assistant', summary: 'settings, at the Assistant: model, voice, devices' },
  { name: 'mic', summary: 'the Assistant: stop/start listening' },
  { name: 'speaker', summary: 'the Assistant: stop/start speaking' },
  { name: 'headphones', summary: 'the Assistant: headphones mode on/off' },
  { name: 'wake', summary: 'the Assistant: wake word on/off' },
  { name: 'ask', summary: 'type something to the Assistant', args: 'text' },
  { name: 'rename', summary: 'name this session (blank goes back to auto-titles)', args: 'name' },
  { name: 'pin', summary: 'pin this session to the top of /resume (again unpins)' },
  { name: 'done', summary: 'done with this session — unpin it and close it' },
  // Late on purpose: the live menu shows the first MENU_ROWS commands and the
  // everyday ones own those rows; /archived is reached by typing (or [a] on
  // the board), not by arrowing.
  { name: 'archived', summary: 'archived cards — browse and restore' },
  { name: 'help', summary: 'what these do' },
  { name: 'exit', summary: 'quit' },
];

/** Is this input a slash command attempt at all? */
export const isCommand = (s: string) => s.startsWith('/');

/** The command word and whatever follows it. */
function split(input: string): { head: string; args: string; hasArgs: boolean } {
  const body = input.slice(1);
  const m = /^(\S*)(\s+([\s\S]*))?$/.exec(body);
  const head = (m?.[1] ?? '').toLowerCase();
  const args = (m?.[3] ?? '').trim();
  // "/ask " (a space after a complete name) already means "the argument comes
  // next": the menu steps aside so typing is not fighting a highlighted row.
  return { head, args, hasArgs: m?.[2] !== undefined && head.length > 0 };
}

/** What the live menu shows: command rows, or — once a picking command's name
 *  is complete and a space typed — that command's choices. `command` is set
 *  only in the second case; it is the one the rows are arguments to. */
export interface Menu { command?: Command; rows: Choice[] }

const prefixed = (name: string, typed: string) => name.toLowerCase().startsWith(typed.toLowerCase());

/** Rows matching what has been typed so far, for the live menu. */
export function matches(input: string, choices?: Choices): Menu {
  if (!isCommand(input)) return { rows: [] };
  const { head, args, hasArgs } = split(input);
  if (!hasArgs) return { rows: COMMANDS.filter((c) => c.name.startsWith(head)) };
  const command = COMMANDS.find((c) => c.name === head);
  if (!command?.picks || !choices) return { rows: [] };
  // The whole line after the name is the argument, spaces and all — a
  // workspace called "Marketing Site" is one choice, not two words.
  return { command, rows: choices(command).filter((c) => prefixed(c.name, args)) };
}

/** Resolve typed input to exactly one command (plus its argument), or say why not. */
export function parse(input: string): { command?: Command; args?: string; error?: string } {
  const { head, args } = split(input);
  if (!head) return { error: 'type a command name' };
  const exact = COMMANDS.find((c) => c.name === head);
  if (exact) return { command: exact, args };
  const partial = COMMANDS.filter((c) => c.name.startsWith(head));
  if (partial.length === 1) return { command: partial[0], args };
  if (partial.length > 1) return { error: `/${head} is ambiguous: ${partial.map((c) => `/${c.name}`).join(', ')}` };
  return { error: `unknown command /${head} — try /help` };
}

/** Longest string every candidate starts with. */
function commonPrefix(names: string[]): string {
  if (!names.length) return '';
  let out = names[0];
  for (const n of names.slice(1)) {
    let i = 0;
    while (i < out.length && i < n.length && out[i] === n[i]) i++;
    out = out.slice(0, i);
  }
  return out;
}

/** The line that names this row outright: a command with the space that
 *  invites its argument, or a command and its picked argument. */
const filled = (menu: Menu, row: Choice) =>
  menu.command ? `/${menu.command.name} ${row.name}` : `/${row.name} `;

/**
 * Tab. One match completes it outright; several complete as far as they agree,
 * which is the shell behaviour people already have in their fingers — never a
 * silent no-op, and never a guess between two commands.
 * `index` picks a specific candidate when the user has arrowed through the list.
 */
export function complete(input: string, index?: number, choices?: Choices): string {
  const menu = matches(input, choices);
  const m = menu.rows;
  if (!m.length) return input;
  if (index !== undefined && m[index]) return filled(menu, m[index]);
  if (m.length === 1) return filled(menu, m[0]);
  const shared = commonPrefix(m.map((c) => c.name));
  const typed = menu.command ? split(input).args : input.slice(1);
  return shared.length > typed.length ? (menu.command ? `/${menu.command.name} ${shared}` : `/${shared}`) : input;
}
