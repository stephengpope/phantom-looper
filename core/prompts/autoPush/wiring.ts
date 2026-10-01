// Auto-push's wiring — fills ./autoPush.ts (the document).
import { fill } from '../template.js';
import { RESOLVE_CONFLICT, COMMIT_MESSAGE } from './autoPush.js';

/** A bullet, not an indent: fill trims a value's edges once, so leading spaces
 *  on the FIRST line never survive and a space-indented block comes out ragged. */
const bullets = (lines: string[], empty: string) =>
  (lines.length ? lines : [empty]).map((l) => `- ${l}`).join('\n');

export const toCodingAgent = {
  /** The one message a stopped rebase sends. `arrived` is the log of what
   *  landed on base — the briefing that separates resolving a conflict from
   *  guessing at one. */
  resolveConflict: (
    branch: string, base: string, files: string[], arrived: string[],
  ) => fill(RESOLVE_CONFLICT, {
    branch, base,
    files: bullets(files, '(none reported — run git status)'),
    arrived: bullets(arrived, '(nothing new — the conflict is with an earlier state of the branch)'),
  }),

  /** A status-update message dropped into the transcript after a successful
   *  sync. Not a prompt — the agent reads it as context on its next turn. */
  syncSummary: (
    base: string, landed: boolean, arrived: string[], files: string[],
  ): string => {
    const parts: string[] = [];
    parts.push(landed
      ? `Your work has been pushed to ${base}${arrived.length ? ` along with ${arrived.length} new commit${arrived.length === 1 ? '' : 's'} that came in from ${base}` : ''}.`
      : `New changes from ${base} have been pulled into your working directory — ${arrived.length} commit${arrived.length === 1 ? '' : 's'} came in.`);
    if (arrived.length) parts.push(arrived.map((l) => `- ${l}`).join('\n'));
    if (files.length) parts.push(`Files changed: ${files.join(', ')}`);
    parts.push('Just letting you know, use as you see fit.');
    return parts.join('\n\n');
  },

  /** The message for a sync that stopped on a conflict nobody resolved (an
   *  instant sync runs without the fixer). The rebase is left stopped with
   *  its markers; the agent is told what came in and where it collides, and
   *  asked to resolve. */
  syncConflict: (base: string, arrived: string[], files: string[]): string => {
    const parts: string[] = [];
    parts.push(`New changes from ${base} could not be pulled in — they conflict with your work.`);
    if (arrived.length) parts.push(arrived.map((l) => `- ${l}`).join('\n'));
    parts.push(`Conflicts: ${files.join(', ')}`);
    parts.push('Resolve the conflict.');
    return parts.join('\n\n');
  },
};

/** `card` empty removes its line whole (fill's optional-line rule). */
export const commitMessagePrompt = (stat: string, diff: string, card = '') =>
  fill(COMMIT_MESSAGE, { stat, diff, card });
