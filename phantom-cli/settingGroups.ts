// How settings are GROUPED on a screen — the one place the cli reads
// `meta.group` / `meta.subgroup`.
//
// The server declares where every setting and credential files (META and
// CREDENTIALS in phantom-backend/settings.ts) and in what order (declaration
// order). This module folds that into blocks and headings; it decides nothing
// itself. Every settings screen — /settings, /keys, /presets, a workspace's
// own — goes through here, so a group renamed or a key moved on the server
// moves on all of them at once, and no screen keeps its own order of keys.
// Three of them used to, and one had drifted into a hand-written list.
import type { Choice } from './components/SelectList.js';

/** The part of an item that says where it files. `WireMeta` satisfies it. */
export interface Filed { group?: string; subgroup?: string }

/** The rows under one (group, subgroup) pair, in the order they arrived. */
export interface Block<T> { group: string; subgroup: string; items: T[] }

/** Fold items into blocks — group, then subgroup within it — in order of
 *  first appearance, which is the server's declaration order. */
export function groupBlocks<T>(items: readonly T[], filed: (item: T) => Filed | undefined): Block<T>[] {
  const out: Block<T>[] = [];
  const find = (group: string, subgroup: string) =>
    out.find((b) => b.group === group && b.subgroup === subgroup);
  for (const item of items) {
    const f = filed(item);
    const group = f?.group ?? '';
    const subgroup = f?.subgroup ?? '';
    let block = find(group, subgroup);
    if (!block) {
      // A new subgroup joins its group's blocks, not the end of the list, so
      // a group's rows are never split by another group's.
      block = { group, subgroup, items: [] };
      const lastOfGroup = out.map((b) => b.group).lastIndexOf(group);
      out.splice(lastOfGroup < 0 ? out.length : lastOfGroup + 1, 0, block);
    }
    block.items.push(item);
  }
  return out;
}

/** The blocks as list rows with a dim heading where the group changes and a
 *  sub-heading where the subgroup does. A heading is only drawn when there is
 *  something to tell apart: one group on the screen gets no group heading
 *  (it would repeat the title), one subgroup in a group no sub-heading. */
export function headedChoices<T>(blocks: readonly Block<T>[], row: (item: T) => Choice<string>): Choice<string>[] {
  const groups = new Set(blocks.map((b) => b.group));
  const subsIn = (g: string) => blocks.filter((b) => b.group === g).length;
  const out: Choice<string>[] = [];
  let lastGroup: string | undefined;
  for (const b of blocks) {
    if (b.group !== lastGroup) {
      if (groups.size > 1 && b.group) out.push({ value: `#g:${b.group}`, label: b.group, heading: true });
      lastGroup = b.group;
    }
    if (subsIn(b.group) > 1 && b.subgroup) {
      out.push({ value: `#s:${b.group}:${b.subgroup}`, label: `  ${b.subgroup}`, heading: true });
    }
    out.push(...b.items.map(row));
  }
  return out;
}
