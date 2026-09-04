// Turns the agent's markdown into what Telegram actually wants: plain text plus
// a list of formatting spans ("characters 10-14 are bold").
//
// This is the `entities` route, not the `parse_mode` route, and the difference
// is the whole point. Sending MarkdownV2 or HTML means encoding the formatting
// INTO the string, which means every `.` `-` `(` the user's prose happens to
// contain has to be escaped perfectly or Telegram rejects the message outright
// — a 400, and the text is simply lost. Entities keep the text untouched and
// describe the formatting alongside it, so there is no string to malform and no
// failure mode to fall back from.
//
// That is also what makes this safe to run on every streamed frame. hermes
// (../hermes-agent, `plugins/platforms/telegram/adapter.py:4819`) formats only
// the FINAL message and sends every intermediate edit raw, because a half-typed
// `**bo` is invalid MarkdownV2 and would 400 roughly once per second for the
// length of a reply. Here a half-typed `**bo` simply parses as the literal text
// `**bo` — it renders as itself until the closing `**` arrives, then becomes
// bold. Degrading to today's behaviour mid-construct, never to a lost message.
//
// Offsets are in UTF-16 code units, which is exactly what a JavaScript string
// index already is — `.length` and `.slice()` agree with Telegram for free.
// (Python has to encode to utf-16-le to get the same numbers, which is why the
// emoji-offset bug is a known one over there and cannot occur here.)
//
// CommonMark only, deliberately: the one dependency is
// `mdast-util-from-markdown`, the smallest parser that agrees with what the
// agents actually write. GFM tables and `~~strike~~` would need further
// extensions; a stray pipe table arrives as plain text rather than pulling in
// a second parser.
//
// Ported whole from ../shockwave (api/src/telegram/markdownEntities.ts) —
// battle-tested there; the UTF-16 pin lives in test/telegram.test.ts.

import { fromMarkdown } from 'mdast-util-from-markdown';

/**
 * One formatting span. Mirrors Telegram's MessageEntity for the subset we emit
 * — `url` only on `text_link`, `language` only on `pre`.
 */
export type Entity = {
  type: 'bold' | 'italic' | 'code' | 'pre' | 'text_link' | 'blockquote';
  offset: number;
  length: number;
  url?: string;
  language?: string;
};

export type Formatted = { text: string; entities: Entity[] };

/**
 * Accumulates the plain text and the spans over it. Every `mark` is recorded
 * against a start offset captured BEFORE the children were written, which is
 * what lets nesting fall out of ordinary recursion rather than needing a
 * separate pass.
 */
class Out {
  text = '';
  entities: Entity[] = [];

  add(s: string) { this.text += s; }

  /** Close a span that began at `start`. Zero-length spans are dropped —
   *  Telegram rejects them, and they mean the node rendered nothing. */
  mark(type: Entity['type'], start: number, extra: Partial<Entity> = {}) {
    const length = this.text.length - start;
    if (length > 0) this.entities.push({ type, offset: start, length, ...extra });
  }

  /** Trailing blank line between blocks, collapsed so an empty block can't
   *  stack separators into a gap. */
  block() {
    if (this.text.length) this.text = this.text.replace(/\n*$/, '') + '\n\n';
  }
}

/** Inline nodes — everything that lives inside a paragraph, heading or list item. */
function inline(node: any, out: Out) {
  switch (node.type) {
    case 'text':
      out.add(node.value);
      break;

    case 'strong': {
      const start = out.text.length;
      (node.children || []).forEach((c: any) => inline(c, out));
      out.mark('bold', start);
      break;
    }

    case 'emphasis': {
      const start = out.text.length;
      (node.children || []).forEach((c: any) => inline(c, out));
      out.mark('italic', start);
      break;
    }

    // `code` and `pre` may not contain other entities, so the value goes in
    // literally and no children are walked (an inlineCode node has none anyway).
    case 'inlineCode': {
      const start = out.text.length;
      out.add(node.value);
      out.mark('code', start);
      break;
    }

    case 'link': {
      const start = out.text.length;
      (node.children || []).forEach((c: any) => inline(c, out));
      // A link whose text rendered to nothing still deserves to be reachable,
      // so fall back to showing the URL itself.
      if (out.text.length === start) out.add(node.url || '');
      out.mark('text_link', start, { url: node.url });
      break;
    }

    // Telegram has no inline images. Show the alt text (or the filename) and
    // make it reachable, which beats dropping the node silently.
    case 'image': {
      const label = node.alt || node.title || node.url || '';
      const start = out.text.length;
      out.add(label);
      if (node.url) out.mark('text_link', start, { url: node.url });
      break;
    }

    case 'break':
      out.add('\n');
      break;

    // Raw HTML the agent wrote into its markdown. Shown as-is: it is text the
    // user typed or the agent produced, and inventing a rendering for it would
    // be guessing.
    case 'html':
      out.add(node.value);
      break;

    default:
      (node.children || []).forEach((c: any) => inline(c, out));
  }
}

/**
 * Block nodes. `depth` is the list nesting level, used only for indentation.
 *
 * Headings become bold lines and list bullets become `•` — Telegram has no
 * heading or list syntax at all, so these are presentation decisions rather
 * than translations. Both are taken from hermes, which landed on the same two
 * after considerably more Telegram traffic than we have had.
 */
function block(node: any, out: Out, depth = 0) {
  switch (node.type) {
    case 'root':
      (node.children || []).forEach((c: any, i: number) => {
        if (i) out.block();
        block(c, out, depth);
      });
      break;

    case 'paragraph':
      (node.children || []).forEach((c: any) => inline(c, out));
      break;

    case 'heading': {
      const start = out.text.length;
      (node.children || []).forEach((c: any) => inline(c, out));
      out.mark('bold', start);
      break;
    }

    case 'list': {
      const items = node.children || [];
      items.forEach((item: any, i: number) => {
        if (i) out.add('\n');
        const marker = node.ordered ? `${(node.start ?? 1) + i}. ` : '• ';
        out.add('  '.repeat(depth) + marker);
        // A list item holds blocks. The first paragraph continues the bullet
        // line; anything after it (a nested list, a second paragraph) starts a
        // new line so the bullet stays readable.
        (item.children || []).forEach((child: any, j: number) => {
          if (j) out.add('\n');
          block(child, out, depth + 1);
        });
      });
      break;
    }

    case 'blockquote': {
      const start = out.text.length;
      (node.children || []).forEach((c: any, i: number) => {
        if (i) out.add('\n');
        block(c, out, depth);
      });
      // Telegram forbids nested blockquotes, so only the outermost is marked —
      // an inner one contributes its text and nothing else.
      if (depth === 0) out.mark('blockquote', start);
      break;
    }

    case 'code': {
      const start = out.text.length;
      out.add(node.value || '');
      out.mark('pre', start, node.lang ? { language: node.lang } : {});
      break;
    }

    case 'thematicBreak':
      out.add('───');
      break;

    // Paragraph-level content reached directly (loose list items, html blocks).
    default:
      if (node.value != null) out.add(String(node.value));
      else (node.children || []).forEach((c: any) => inline(c, out));
  }
}

/**
 * The whole job: markdown in, Telegram's two fields out.
 *
 * Never throws. A parse that goes wrong returns the original text with no
 * formatting, which is exactly what Telegram receives today — the failure mode
 * is "not bold", never "not delivered".
 */
export function toTelegram(md: string): Formatted {
  const text = md ?? '';
  if (!text) return { text: '', entities: [] };
  try {
    const out = new Out();
    block(fromMarkdown(text), out);
    // Block separators leave a trailing blank line on the last block.
    out.text = out.text.replace(/\s+$/, '');
    return { text: out.text, entities: clampEntities(out.entities, 0, out.text.length) };
  } catch {
    return { text, entities: [] };
  }
}

/**
 * Cut a span list down to the window `[start, end)` and rebase it to 0.
 *
 * This is what replaces the code-fence surgery the string-based route needs:
 * where MarkdownV2 has to close an open ``` at a chunk boundary and reopen it
 * on the next chunk (and hermes carries a further patch for the `(1/2)` marker
 * landing on that reopened fence line), a span that straddles a cut simply
 * becomes two spans, one per side. Nothing to balance and nothing to escape.
 */
export function clampEntities(entities: Entity[], start: number, end: number): Entity[] {
  const out: Entity[] = [];
  for (const e of entities) {
    const from = Math.max(e.offset, start);
    const to = Math.min(e.offset + e.length, end);
    if (to > from) out.push({ ...e, offset: from - start, length: to - from });
  }
  return out;
}

/**
 * Truncate formatted text, keeping the spans that survive. Used on the
 * streaming path, where a reply longer than Telegram's limit is shown cut off
 * until the final message splits it properly.
 */
export function truncateFormatted(f: Formatted, limit: number): Formatted {
  if (f.text.length <= limit) return f;
  return { text: f.text.slice(0, limit), entities: clampEntities(f.entities, 0, limit) };
}

/**
 * Chunk a formatted message under Telegram's limit. Replaced `splitMessage` in
 * `client.ts` outright — every caller carries entities now, and two chunkers
 * where one is never reached is how they drift.
 *
 * Splits on paragraph > line > space, never mid-word, as the old one did. What
 * it does NOT need is that function's code-fence bookkeeping: a
 * code block is a span here, not a pair of ``` markers in the text, so a block
 * straddling a boundary is cut by `clampEntities` into one span per chunk and
 * both sides render as code. The `(i/n)` marker is appended AFTER the spans are
 * rebased, so it cannot shift them.
 */
export function splitFormatted(f: Formatted, limit = 4096): Formatted[] {
  if (f.text.length <= limit) return [f];
  const chunks: Formatted[] = [];
  let at = 0;

  while (at < f.text.length) {
    const budget = limit - 12;        // room for the "\n\n(i/n)" marker
    const remaining = f.text.length - at;
    if (remaining <= budget) {
      chunks.push({ text: f.text.slice(at), entities: clampEntities(f.entities, at, f.text.length) });
      break;
    }

    const window = f.text.slice(at, at + budget);
    let cut = window.lastIndexOf('\n\n');
    if (cut < budget * 0.5) cut = window.lastIndexOf('\n');
    if (cut < budget * 0.5) cut = window.lastIndexOf(' ');
    if (cut <= 0) cut = budget;

    const end = at + cut;
    chunks.push({ text: f.text.slice(at, end), entities: clampEntities(f.entities, at, end) });
    // Leading newlines belong to the break, not to the next chunk's first line.
    at = end;
    while (f.text[at] === '\n') at++;
  }

  const n = chunks.length;
  if (n <= 1) return chunks;
  return chunks.map((c, i) => ({ ...c, text: `${c.text}\n\n(${i + 1}/${n})` }));
}
