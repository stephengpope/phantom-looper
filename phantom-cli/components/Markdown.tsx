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

import chalk from 'chalk';
import { Text } from './Text.js';
import { useMemo } from 'react';

// ─── ANSI helpers ───────────────────────────────────────────────────────────

/** Strip ANSI SGR sequences to measure visible character width. */
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visibleLength = (s: string) => s.replace(ANSI_RE, '').length;

/** Pad `s` with trailing spaces until its visible width reaches `w`. */
const padRight = (s: string, w: number) => {
  const gap = Math.max(0, w - visibleLength(s));
  return gap > 0 ? s + ' '.repeat(gap) : s;
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
        const m = full.match(/^(`+)([\s\S]+)\1$/);
        return m ? chalk.cyan(m[2]) : full;
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
const HR         = /^\s*([-*_]\s*){3,}\s*$/;
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
    const th = TABLE_ROW.exec(line);
    if (th && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const headers = th[1].split('|').map(s => s.trim());
      i += 2; // header + separator
      const rows: string[][] = [];
      while (i < lines.length) {
        const r = TABLE_ROW.exec(lines[i]);
        if (!r) break;
        rows.push(r[1].split('|').map(s => s.trim()));
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
    if (HR.test(line)) {
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
      out.push(qLines.map(l => chalk.dim('│ ') + formatInline(l)).join('\n'));
      continue;
    }

    // ── unordered list ────────────────────────────────────────────────
    const ul = UL_ITEM.exec(line);
    if (ul) {
      const depth = Math.floor(ul[1].length / 2);
      out.push(`${'  '.repeat(depth)}• ${formatInline(ul[3])}`);
      i++;
      continue;
    }

    // ── ordered list ──────────────────────────────────────────────────
    const ol = OL_ITEM.exec(line);
    if (ol) {
      const depth = Math.floor(ol[1].length / 2);
      out.push(`${'  '.repeat(depth)}${ol[2]}. ${formatInline(ol[3])}`);
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

function renderCodeBlock(lines: string[], lang: string): string {
  const parts: string[] = [];
  if (lang) parts.push(chalk.dim(`  ${lang}`));
  const border = chalk.dim('│');
  for (const l of lines) parts.push(`${border} ${l}`);
  return parts.join('\n');
}

// ─── table ──────────────────────────────────────────────────────────────────

function renderTable(headers: string[], rows: string[][], width: number): string {
  const numCols = headers.length;

  // Normalise every row to the header's column count.
  const norm = rows.map(r => {
    const n = [...r];
    while (n.length < numCols) n.push('');
    return n.slice(0, numCols);
  });
  const allCells = [headers, ...norm];

  // ── column widths from raw content lengths ──
  const colW = Array.from({ length: numCols }, (_, c) =>
    Math.max(3, ...allCells.map(r => (r[c] ?? '').length)),
  );

  // Shrink proportionally when the table exceeds the available width.
  const PAD = 2;           // 1 space each side of cell content
  const overhead = numCols + 1 + numCols * PAD;   // borders + padding
  const budget = Math.max(numCols * 3, width - overhead);
  const total = colW.reduce((s, w) => s + w, 0);
  if (total > budget) {
    const scale = budget / total;
    for (let c = 0; c < numCols; c++) colW[c] = Math.max(3, Math.floor(colW[c] * scale));
  }

  // ── drawing helpers ──
  const dim = chalk.dim;
  const hline = (l: string, m: string, r: string) =>
    dim(l + colW.map(w => '─'.repeat(w + PAD)).join(m) + r);

  const fmtRow = (cells: string[], isHeader: boolean) => {
    const parts = cells.map((cell, c) => {
      const truncated = cell.length > colW[c] ? cell.slice(0, colW[c] - 1) + '…' : cell;
      const styled = isHeader ? chalk.bold(formatInline(truncated)) : formatInline(truncated);
      return ' ' + padRight(styled, colW[c]) + ' ';
    });
    return dim('│') + parts.join(dim('│')) + dim('│');
  };

  const out: string[] = [];
  out.push(hline('┌', '┬', '┐'));
  out.push(fmtRow(headers, true));
  out.push(hline('├', '┼', '┤'));
  for (const r of norm) out.push(fmtRow(r, false));
  out.push(hline('└', '┴', '┘'));
  return out.join('\n');
}

// ─── React component ────────────────────────────────────────────────────────

export function Markdown({ text, width }: { text: string; width: number }) {
  const out = useMemo(() => renderMarkdown(text, width), [text, width]);
  return <Text>{out}</Text>;
}
