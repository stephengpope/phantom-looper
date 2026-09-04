// Finished assistant text → ANSI via marked + marked-terminal (the choice of
// the smaller Ink agents — Codex-TS, Grok CLI; the big ones hand-roll Ink
// layouts). Rendered once per completed message, never while streaming.
//
// marked-terminal 7.3 (its last release) has two gaps that agent replies hit
// constantly; both are patched here as marked renderer overrides — its own
// extension mechanism, so nothing in node_modules is touched:
//   · a `text` token renders as its raw source, dropping the inline children
//     a tight list item carries — `- item **one**` printed the asterisks;
//   · its ordered-list numbering ignores the token's `start` — a list that
//     resumes at 2 (after a code block, or a block committed by the streaming
//     splitter) printed 1. again — and accepts a bullet at ANY indent as the
//     next item, so a sub-bullet under 2. was printed as 3.;
//   · a nested list leaves a line holding only spaces and a colour reset
//     between its items (its blank-line filter tests for the empty string),
//     drawn as a blank row — and with colour off that line vanishes, which
//     is what exposed the miscount above.
import { Text } from './Text.js';
import { Marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { useMemo } from 'react';

/** List indent, in spaces — the `tab` option; top-level items start here. */
const TAB = 2;
/** A top-level bullet line as marked-terminal draws it. */
const TOP_BULLET = new RegExp(`^( {${TAB}})\\* `, 'gm');
/** A line that draws nothing: spaces and colour codes only. */
const BLANK_LINE = /^(?:\s|\x1b\[[0-9;]*m)*$/;

const renderers = new Map<number, Marked>();
function rendererFor(width: number): Marked {
  let m = renderers.get(width);
  if (!m) {
    m = new Marked();
    m.use(markedTerminal({ width, reflowText: true, tab: TAB }) as never);
    const list = m.defaults.renderer!.list;
    m.use({
      renderer: {
        // marked's own renderer parses the children first; fall through
        // (false) for a leaf text token so marked-terminal styles it.
        text(token) {
          return 'tokens' in token && token.tokens ? this.parser.parseInline(token.tokens) : false;
        },
        // Every list is rendered as bullets with its blank rows dropped; an
        // ordered one then has its top-level lines (exactly TAB spaces in)
        // numbered here from `start`. Nested lists sit deeper and number
        // themselves through this same override; wrapped lines wear a blank
        // prefix — neither matches.
        list(token) {
          const out = list.call(this, token.ordered ? { ...token, ordered: false } : token);
          const body = out.replace(/\s+$/, '').split('\n').filter((l) => !BLANK_LINE.test(l)).join('\n');
          if (!token.ordered) return body + '\n\n';
          let n = (typeof token.start === 'number' ? token.start : 1) - 1;
          return body.replace(TOP_BULLET, (_m, sp: string) => `${sp}${++n}. `) + '\n\n';
        },
      },
    });
    renderers.set(width, m);
  }
  return m;
}

/** The markdown as ANSI text, trailing whitespace dropped. */
export function renderMarkdown(text: string, width: number): string {
  try {
    return String(rendererFor(width).parse(text)).replace(/\s+$/, '');
  } catch {
    return text;
  }
}

export function Markdown({ text, width }: { text: string; width: number }) {
  const out = useMemo(() => renderMarkdown(text, width), [text, width]);
  return <Text>{out}</Text>;
}
