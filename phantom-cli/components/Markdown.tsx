// Hand-rolled markdown renderer for terminal output.
//
// Replaces marked + marked-terminal with a line-by-line parser that:
//   · renders inline formatting (bold, italic, code, links) during streaming
//     — no more raw **asterisks** flashing before the block commits
//   · draws GFM tables with box-drawing characters instead of raw pipes
//   · handles headers, lists, code fences, blockquotes, horizontal rules
//   · works with Ink's ANSI-aware text wrapping (no manual reflow needed)
//
// The approach is proven at scale: Gemini CLI hand-rolls ~700 lines of the
// same thing (MarkdownDisplay.tsx + markdownParsingUtils.ts) because no
// maintained library handles streaming + tables + Ink together.

import chalk, { type ChalkInstance } from 'chalk';
import { Text } from './Text.js';
import { useMemo } from 'react';
import { createLowlight, common } from 'lowlight';

// ─── ANSI helpers ───────────────────────────────────────────────────────────

/** Strip ANSI SGR sequences to measure visible character width. */
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visibleLength = (text: string) => text.replace(ANSI_RE, '').length;

/** Pad `s` with trailing spaces until its visible width reaches `width`. */
const padRight = (text: string, width: number) => {
  const gap = Math.max(0, width - visibleLength(text));
  return gap > 0 ? text + ' '.repeat(gap) : text;
};

// ─── inline formatting ─────────────────────────────────────────────────────

// Regex matching inline markdown. Alternation order is critical:
//   1. Multi-backtick code spans (``` or ``) — highest priority, verbatim
//   2. Single-backtick code spans
//   3. Bold-italic (***)
//   4. Bold (**)
//   5. Italic (* and _) with word-boundary guards so file_names aren't styled
//   6. Strikethrough (~~)
//   7. Links [text](url)
//
// Each alternative is self-contained on one line, so this is safe to run on
// streaming text without waiting for a block to close. Unbalanced markers
// (e.g. a half-typed `**bol`) simply don't match and pass through as-is.
const INLINE = /(```[^`]+```|``[^`]+``|`[^`\n]+`|\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|(?<!\w)\*(.+?)\*(?!\w)|(?<!\w)_(.+?)_(?!\w)|~~(.+?)~~|\[([^\]]+)\]\(([^)]+)\))/g;

/** Format one line of inline markdown to ANSI. Safe on partial / streaming
 *  text — unbalanced markers pass through unchanged because the regex
 *  requires matched pairs. */
export function formatInline(text: string): string {
  // Fast path: skip the regex when the line has no markers.
  if (!/[*_~`\[]/.test(text)) return text;
  return text.replace(INLINE,
    (full, _whole, boldItalic, bold, italic, under, strike, linkText, linkUrl) => {
      // Code spans — strip matched backticks, show as cyan.
      if (full.startsWith('`')) {
        const match = full.match(/^(`+)([\s\S]+)\1$/);
        return match ? chalk.cyan(match[2]) : full;
      }
      if (boldItalic !== undefined) return chalk.bold.italic(formatInline(boldItalic));
      if (bold !== undefined) return chalk.bold(formatInline(bold));
      if (italic !== undefined) return chalk.italic(formatInline(italic));
      if (under !== undefined) return chalk.italic(formatInline(under));
      if (strike !== undefined) return chalk.strikethrough(formatInline(strike));
      if (linkText !== undefined) return `${formatInline(linkText)} ${chalk.dim(`(${linkUrl})`)}`;
      return full;
    },
  );
}

// ─── block-level patterns ───────────────────────────────────────────────────

const FENCE_OPEN = /^(\s{0,3})(```+|~~~+)\s*(\S*)\s*$/;
const HEADER     = /^(#{1,4})\s+(.*)/;
const HORIZONTAL_RULE         = /^\s*([-*_]\s*){3,}\s*$/;
const BLOCKQUOTE = /^\s*>\s?/;
const UL_ITEM    = /^(\s*)([-*+])\s+(.*)/;
const OL_ITEM    = /^(\s*)(\d+)[.)]\s+(.*)/;
const TABLE_ROW  = /^\s*\|(.+)\|\s*$/;
const TABLE_SEP  = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

// ─── block-level rendering ─────────────────────────────────────────────────

/** The markdown as ANSI text, trailing whitespace dropped.
 *  Drop-in replacement for the old marked + marked-terminal pipeline. */
export function renderMarkdown(text: string, width: number): string {
  try { return renderBlocks(text, width); }
  catch { return text; }
}

function renderBlocks(text: string, width: number): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // ── code fence ────────────────────────────────────────────────────
    const fence = FENCE_OPEN.exec(line);
    if (fence) {
      const marker = fence[2];
      const lang = fence[3];
      const code: string[] = [];
      i++;
      while (i < lines.length) {
        const end = FENCE_OPEN.exec(lines[i]);
        if (end && end[2][0] === marker[0] && end[2].length >= marker.length && !end[3]) {
          i++;
          break;
        }
        code.push(lines[i]);
        i++;
      }
      out.push(renderCodeBlock(code, lang));
      continue;
    }

    // ── table ─────────────────────────────────────────────────────────
    const tableHead = TABLE_ROW.exec(line);
    if (tableHead && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const headers = tableHead[1].split('|').map(text => text.trim());
      i += 2; // header + separator
      const rows: string[][] = [];
      while (i < lines.length) {
        const row = TABLE_ROW.exec(lines[i]);
        if (!row) break;
        rows.push(row[1].split('|').map(text => text.trim()));
        i++;
      }
      out.push(renderTable(headers, rows, width));
      continue;
    }

    // ── header ────────────────────────────────────────────────────────
    const hdr = HEADER.exec(line);
    if (hdr) {
      const level = hdr[1].length;
      const content = formatInline(hdr[2]);
      out.push(level <= 2 ? chalk.bold(content) : chalk.bold.dim(content));
      i++;
      continue;
    }

    // ── horizontal rule ───────────────────────────────────────────────
    if (HORIZONTAL_RULE.test(line)) {
      out.push(chalk.dim('─'.repeat(Math.min(width, 40))));
      i++;
      continue;
    }

    // ── blockquote ────────────────────────────────────────────────────
    if (BLOCKQUOTE.test(line)) {
      const qLines: string[] = [];
      while (i < lines.length && BLOCKQUOTE.test(lines[i])) {
        qLines.push(lines[i].replace(BLOCKQUOTE, ''));
        i++;
      }
      out.push(qLines.map(line => chalk.dim('│ ') + formatInline(line)).join('\n'));
      continue;
    }

    // ── unordered list ────────────────────────────────────────────────
    const unordered = UL_ITEM.exec(line);
    if (unordered) {
      const depth = Math.floor(unordered[1].length / 2);
      out.push(`${'  '.repeat(depth)}• ${formatInline(unordered[3])}`);
      i++;
      continue;
    }

    // ── ordered list ──────────────────────────────────────────────────
    const ordered = OL_ITEM.exec(line);
    if (ordered) {
      const depth = Math.floor(ordered[1].length / 2);
      out.push(`${'  '.repeat(depth)}${ordered[2]}. ${formatInline(ordered[3])}`);
      i++;
      continue;
    }

    // ── blank line ────────────────────────────────────────────────────
    if (line.trim() === '') {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('');
      i++;
      continue;
    }

    // ── paragraph / default ───────────────────────────────────────────
    out.push(formatInline(line));
    i++;
  }

  return out.join('\n').replace(/\n+$/, '');
}

// ─── code block ─────────────────────────────────────────────────────────────

const lowlight = createLowlight(common);

/** Map highlight.js CSS classes to chalk styles. */
const HLJS_STYLES: Record<string, ChalkInstance> = {
  'hljs-keyword':    chalk.blue,
  'hljs-built_in':   chalk.cyan,
  'hljs-type':       chalk.cyan.dim,
  'hljs-literal':    chalk.blue,
  'hljs-number':     chalk.green,
  'hljs-string':     chalk.green,
  'hljs-regexp':     chalk.red,
  'hljs-symbol':     chalk.green,
  'hljs-bullet':     chalk.green,
  'hljs-link':       chalk.cyan.underline,
  'hljs-title':      chalk.yellow,
  'hljs-section':    chalk.yellow,
  'hljs-name':       chalk.blue,
  'hljs-attr':       chalk.cyan,
  'hljs-attribute':  chalk.cyan,
  'hljs-variable':   chalk.red,
  'hljs-params':     chalk.white,
  'hljs-comment':    chalk.dim,
  'hljs-doctag':     chalk.dim,
  'hljs-meta':       chalk.dim,
  'hljs-tag':        chalk.dim,
  'hljs-selector-tag':   chalk.blue,
  'hljs-selector-id':    chalk.yellow,
  'hljs-selector-class': chalk.yellow,
  'hljs-template-variable': chalk.red,
  'hljs-template-tag':      chalk.blue,
  'hljs-addition':   chalk.green,
  'hljs-deletion':   chalk.red,
};

/** Walk a lowlight HAST tree and produce an ANSI string. */
function hastToAnsi(nodes: ReturnType<typeof lowlight.highlight>['children']): string {
  let out = '';
  for (const node of nodes) {
    if (node.type === 'text') { out += node.value; continue; }
    if (node.type === 'element') {
      const cls = (node.properties?.className as string[] | undefined)?.[0] ?? '';
      const style = HLJS_STYLES[cls];
      const inner = hastToAnsi(node.children);
      out += style ? style(inner) : inner;
    }
  }
  return out;
}

function renderCodeBlock(lines: string[], lang: string): string {
  const code = lines.join('\n');
  let highlighted: string;
  try {
    const tree = lang && lowlight.listLanguages().includes(lang)
      ? lowlight.highlight(lang, code)
      : lowlight.highlightAuto(code);
    highlighted = hastToAnsi(tree.children);
  } catch {
    highlighted = code;
  }
  const parts: string[] = [];
  if (lang) parts.push(chalk.dim(`  ${lang}`));
  const border = chalk.dim('│');
  for (const line of highlighted.split('\n')) parts.push(`${border} ${line}`);
  return parts.join('\n');
}

// ─── table ──────────────────────────────────────────────────────────────────

function renderTable(headers: string[], rows: string[][], width: number): string {
  const numCols = headers.length;

  // Normalise every row to the header's column count.
  const norm = rows.map(row => {
    const cells = [...row];
    while (cells.length < numCols) cells.push('');
    return cells.slice(0, numCols);
  });
  const allCells = [headers, ...norm];

  // ── column widths from raw content lengths ──
  const colW = Array.from({ length: numCols }, (_, column) =>
    Math.max(3, ...allCells.map(row => (row[column] ?? '').length)),
  );

  // Shrink proportionally when the table exceeds the available width.
  const PAD = 2;           // 1 space each side of cell content
  const overhead = numCols + 1 + numCols * PAD;   // borders + padding
  const budget = Math.max(numCols * 3, width - overhead);
  const total = colW.reduce((sum, columnWidth) => sum + columnWidth, 0);
  if (total > budget) {
    const scale = budget / total;
    for (let column = 0; column < numCols; column++) colW[column] = Math.max(3, Math.floor(colW[column] * scale));
  }

  // ── drawing helpers ──
  const dim = chalk.dim;
  const hline = (left: string, middle: string, right: string) =>
    dim(left + colW.map(columnWidth => '─'.repeat(columnWidth + PAD)).join(middle) + right);

  const fmtRow = (cells: string[], isHeader: boolean) => {
    const parts = cells.map((cell, column) => {
      const truncated = cell.length > colW[column] ? cell.slice(0, colW[column] - 1) + '…' : cell;
      const styled = isHeader ? chalk.bold(formatInline(truncated)) : formatInline(truncated);
      return ' ' + padRight(styled, colW[column]) + ' ';
    });
    return dim('│') + parts.join(dim('│')) + dim('│');
  };

  const out: string[] = [];
  out.push(hline('┌', '┬', '┐'));
  out.push(fmtRow(headers, true));
  out.push(hline('├', '┼', '┤'));
  for (const row of norm) out.push(fmtRow(row, false));
  out.push(hline('└', '┴', '┘'));
  return out.join('\n');
}

// ─── React component ────────────────────────────────────────────────────────

export function Markdown({ text, width }: { text: string; width: number }) {
  const out = useMemo(() => renderMarkdown(text, width), [text, width]);
  return <Text>{out}</Text>;
}
