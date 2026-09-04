// How every prompt is built: a prompt file is TEMPLATES — flat text with
// blanks written as {{name}} right where they land — plus a few wiring lines
// that fill them. fill() is the whole mechanism.
//
// A prompt is assembled ONCE, when its agent's chat begins, and the result is
// frozen with that chat (the TUI stores it in the transcript header; a voice
// run keeps it for the sidecar's life; a Git Fixer run is one conversation).
// Editing a prompt file changes NEW chats only — that is the point, not a
// limitation. Anything a model must always see current belongs in a tool's
// description, which reaches every chat, never in here.

const token = () => /\{\{([a-zA-Z]\w*)\}\}/g;

/** Substitute every {{name}} in the template with its value. A blank with no
 *  value throws (loud — a template and its wiring must agree). A line whose
 *  blanks all resolve EMPTY vanishes whole — an optional line is written in
 *  the template where it appears, label and all, and simply isn't there when
 *  its value is. Values are inserted verbatim, never re-scanned — braces
 *  inside a value (JSON, diffs) are safe.
 *
 *  WHITESPACE AT THE EDGES NEVER MATTERS — of the template or of any value.
 *  Blank lines around a document's text, a shared block, a card's JSON, are
 *  stripped here, once, so no prompt file has to be written carefully and no
 *  emitted prompt carries a run of blank lines. Spacing INSIDE a value is
 *  the author's and stays verbatim. */
export function fill(template: string, vars: Record<string, string | number>): string {
  const val = (name: string): string => {
    const v = vars[name];
    if (v === undefined) throw new Error(`template blank {${name}} has no value`);
    return String(v).trim();
  };
  const lines = template.split('\n').filter((line) => {
    const names = [...line.matchAll(token())].map((m) => m[1]);
    return !names.length || names.some((n) => val(n) !== '');
  });
  return lines.join('\n')
    .replace(/\n{3,}/g, '\n\n')                    // the gap a dropped line leaves
    .replace(token(), (_, n: string) => val(n))    // values go in last, verbatim
    .trim();
}

/** The first line of what fill() would SEND — the template's first non-blank
 *  line, filled. The looper's frozen first-message discriminators derive
 *  from the templates themselves, so the matched line and the sent line can
 *  never drift apart, and a template that opens on a blank line is no
 *  different from one that doesn't (fill() trims the same way). */
export function firstLineOf(template: string, vars: Record<string, string | number>): string {
  const line = template.split('\n').find((l) => l.trim() !== '') ?? '';
  return fill(line, vars);
}

/** The frozen prompt plus today's date — recomputed at every agent build
 *  (launch, resume, model change), so the stored text never moves. */
export function withCurrentDate(instructions: string, now = new Date()): string {
  const day = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: '2-digit' });
  return `${instructions}\n\nCurrent date: ${day}.`;
}
