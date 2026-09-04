// Slash commands. A plain table so the menu, the matcher and the tests all read
// from one place — and so an unknown /command is an error the user sees rather
// than a message the model has to make sense of.
//
// A command may take the rest of the line as its argument (`/assistant hello`). Only
// the first word is the command; while there is an argument the live menu
// stays out of the way, so enter sends the line rather than the highlighted row.
export interface Command { name: string; summary: string; args?: string }

export const COMMANDS: Command[] = [
  { name: 'new', summary: 'new session in this workspace' },
  { name: 'resume', summary: 'reopen an earlier session' },
  { name: 'workspace', summary: 'start in a different workspace' },
  { name: 'kanban', summary: "this workspace's task board" },
  { name: 'tasks', summary: "what's running in this session's container" },
  { name: 'plan', summary: 'plan mode on/off — the coding agent reads, nothing is written' },
  { name: 'auto-push', summary: "push this session's work to the base branch" },
  { name: 'model', summary: 'provider, model, reasoning, steps per turn' },
  // First row under the fold (the live menu shows MENU_ROWS = 8): closing a
  // session is a real everyday act, but not more everyday than the eight above
  // it, and [x] on /resume already teaches it.
  { name: 'close', summary: 'close this session — it stays on the server' },
  { name: 'server', summary: 'the server url and api key, this machine only' },
  { name: 'settings', summary: "the server's settings, for everyone" },
  { name: 'keys', summary: 'the credentials the server holds' },
  { name: 'secrets', summary: "the coding agent's secrets — tokens it can read and use" },
  { name: 'voice', summary: 'the Assistant: model, voice, devices, wake word' },
  { name: 'mic', summary: 'the Assistant: stop/start listening' },
  { name: 'speaker', summary: 'the Assistant: stop/start speaking' },
  { name: 'headphones', summary: 'the Assistant: headphones mode on/off' },
  { name: 'wake', summary: 'the Assistant: wake word on/off' },
  { name: 'assistant', summary: 'type something to the Assistant', args: 'text' },
  { name: 'rename', summary: 'name this session (blank goes back to auto-titles)', args: 'name' },
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
  // "/assistant " (a space after a complete name) already means "the argument comes
  // next": the menu steps aside so typing is not fighting a highlighted row.
  return { head, args, hasArgs: m?.[2] !== undefined && head.length > 0 };
}

/** Commands matching what has been typed so far, for the live menu. */
export function matches(input: string): Command[] {
  if (!isCommand(input)) return [];
  const { head, hasArgs } = split(input);
  if (hasArgs) return [];
  return COMMANDS.filter((c) => c.name.startsWith(head));
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

/**
 * Tab. One match completes it outright; several complete as far as they agree,
 * which is the shell behaviour people already have in their fingers — never a
 * silent no-op, and never a guess between two commands.
 * `index` picks a specific candidate when the user has arrowed through the list.
 */
export function complete(input: string, index?: number): string {
  const m = matches(input);
  if (!m.length) return input;
  if (index !== undefined && m[index]) return `/${m[index].name} `;
  if (m.length === 1) return `/${m[0].name} `;
  const shared = commonPrefix(m.map((c) => c.name));
  return shared.length > input.length - 1 ? `/${shared}` : input;
}
