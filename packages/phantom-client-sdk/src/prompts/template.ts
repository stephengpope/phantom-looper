// How every prompt is built: a prompt file is TEMPLATES — flat text with
// blanks written as {{name}} right where they land — plus a few wiring
// lines that fill them. fill() is the whole mechanism.
//
// A prompt is assembled ONCE, when its session is created, and frozen on
// the row. Editing a prompt file changes NEW sessions only. Anything a model
// must always see current belongs in a tool's description, never in here.
const token = () => /\{\{([a-zA-Z]\w*)\}\}/g;

/** Substitute every {{name}} with its value. A blank with no value throws.
 *  A line whose blanks all resolve EMPTY vanishes whole. Values are inserted
 *  verbatim, never re-scanned. Whitespace at the edges never matters. */
export function fill(template: string, vars: Record<string, string | number>): string {
  const val = (name: string): string => {
    const v = vars[name];
    if (v === undefined) throw new Error(`template blank {${name}} has no value`);
    return String(v).trim();
  };
  const lines = template.split('\n').filter((line) => {
    const names = [...line.matchAll(token())].map((m) => m[1]!);
    return !names.length || names.some((n) => val(n) !== '');
  });
  return lines.join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(token(), (_, n: string) => val(n))
    .trim();
}

/** The first line of what fill() would SEND — the looper's frozen
 *  first-message discriminators derive from the templates themselves. */
export function firstLineOf(template: string, vars: Record<string, string | number>): string {
  const line = template.split('\n').find((l) => l.trim() !== '') ?? '';
  return fill(line, vars);
}
