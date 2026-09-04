// ONE mechanism for bounding any kit: a kit accepts a named
// preset — presets are defined by us, `readonly` and `full` today, more groups
// later — or an explicit list of tool names. Every kit declares which of its
// tools mutate; presets derive from that. An unknown name throws: a silently
// missing tool is how an agent loses a capability without anyone noticing.
//
// Plan mode, the supervisor's inspection kit, and the coding agent's card-read
// trim are each one line of this.
import type { Tool } from 'ai';

export type KitPick = 'full' | 'readonly' | string[];

/** Bound a kit. `mutating` names the tools a `readonly` preset drops; a tool
 *  not listed there is considered safe to read with. */
export function pickKit(
  tools: Record<string, Tool>, mutating: readonly string[], pick: KitPick = 'full',
): Record<string, Tool> {
  const unknownMutating = mutating.filter((n) => !(n in tools));
  if (unknownMutating.length) throw new Error(`unknown mutating tool(s): ${unknownMutating.join(', ')}`);
  if (pick === 'full') return tools;
  if (pick === 'readonly') {
    const drop = new Set(mutating);
    return Object.fromEntries(Object.entries(tools).filter(([n]) => !drop.has(n)));
  }
  const missing = pick.filter((n) => !(n in tools));
  if (missing.length) throw new Error(`unknown tool(s): ${missing.join(', ')}`);
  const want = new Set(pick);
  return Object.fromEntries(Object.entries(tools).filter(([n]) => want.has(n)));
}
