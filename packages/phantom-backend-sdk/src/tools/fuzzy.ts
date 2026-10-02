// Multi-strategy fuzzy find-and-replace, ported from knack's
// lib/files/fuzzy-match.ts (itself a faithful port of hermes'
// tools/fuzzy_match.py). Battle-tested against the whitespace / indentation /
// escape drift common in LLM-generated edits. Chain, in order:
//   exact -> line-trimmed -> whitespace-normalized -> indentation-flexible ->
//   escape-normalized -> trimmed-boundary -> unicode-normalized ->
//   block-anchor -> context-aware
// Apply-with-disclosure: the caller reports which strategy landed plus a diff,
// and re-reads to verify (see tools/registry.ts edit tool).

export type FuzzyResult = {
  content: string;
  count: number;
  strategy: string | null;
  error: string | null;
};

type Match = [start: number, end: number];

const UNICODE_MAP: Record<string, string> = {
  '\u201c': '"', '\u201d': '"', '\u2018': "'", '\u2019': "'",
  '\u2014': '--', '\u2013': '-', '\u2026': '...', '\u00a0': ' ',
};

function unicodeNormalize(text: string): string {
  let out = text;
  for (const [ch, repl] of Object.entries(UNICODE_MAP)) out = out.split(ch).join(repl);
  return out;
}

export function fuzzyFindAndReplace(
  content: string, oldString: string, newString: string, replaceAll = false,
): FuzzyResult {
  if (!oldString) return { content, count: 0, strategy: null, error: 'old_string cannot be empty' };
  if (oldString === newString) {
    return { content, count: 0, strategy: null, error: 'old_string and new_string are identical' };
  }

  const strategies: [string, (c: string, p: string) => Match[]][] = [
    ['exact', strategyExact],
    ['line_trimmed', strategyLineTrimmed],
    ['whitespace_normalized', strategyWhitespaceNormalized],
    ['indentation_flexible', strategyIndentationFlexible],
    ['escape_normalized', strategyEscapeNormalized],
    ['trimmed_boundary', strategyTrimmedBoundary],
    ['unicode_normalized', strategyUnicodeNormalized],
    ['block_anchor', strategyBlockAnchor],
    ['context_aware', strategyContextAware],
  ];

  for (const [name, fn] of strategies) {
    const matches = fn(content, oldString);
    if (matches.length === 0) continue;
    if (matches.length > 1 && !replaceAll) {
      return {
        content, count: 0, strategy: null,
        error: `Found ${matches.length} matches for old_string. ` +
          `Provide more context to make it unique, or use replace_all=true.`,
      };
    }
    if (name !== 'exact') {
      const driftErr = detectEscapeDrift(content, matches, oldString, newString);
      if (driftErr) return { content, count: 0, strategy: null, error: driftErr };
    }
    const effectiveNew = maybeUnescapeNewString(newString, content, matches);
    const newContent = applyReplacements(content, matches, effectiveNew, name !== 'exact' ? oldString : null);
    return { content: newContent, count: matches.length, strategy: name, error: null };
  }
  return { content, count: 0, strategy: null, error: 'Could not find a match for old_string in the file' };
}

function detectEscapeDrift(
  content: string, matches: Match[], oldString: string, newString: string,
): string | null {
  if (!newString.includes("\\'") && !newString.includes('\\"')) return null;
  const matchedRegions = matches.map(([s, e]) => content.slice(s, e)).join('');
  for (const suspect of ["\\'", '\\"']) {
    if (newString.includes(suspect) && oldString.includes(suspect) && !matchedRegions.includes(suspect)) {
      const plain = suspect[1];
      return `Escape-drift detected: old_string and new_string contain the literal ` +
        `sequence ${JSON.stringify(suspect)} but the matched region of the file does not. ` +
        `This is almost always a serialization artifact where a quote got a spurious ` +
        `backslash. Re-read the file and pass old_string/new_string without ` +
        `backslash-escaping ${JSON.stringify(plain)} characters.`;
    }
  }
  return null;
}

function leadingWhitespace(line: string): string {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(0, i);
}

function firstMeaningfulLine(text: string): string | null {
  for (const line of text.split('\n')) if (line.trim()) return line;
  return null;
}

function reindentReplacement(fileRegion: string, oldString: string, newString: string): string {
  if (!newString) return newString;
  const oldFirst = firstMeaningfulLine(oldString);
  const fileFirst = firstMeaningfulLine(fileRegion);
  if (oldFirst === null || fileFirst === null) return newString;
  const oldIndent = leadingWhitespace(oldFirst);
  const fileIndent = leadingWhitespace(fileFirst);
  if (oldIndent === fileIndent) return newString;
  const out: string[] = [];
  for (const line of newString.split('\n')) {
    if (!line.trim()) { out.push(line); continue; }
    const lineIndent = leadingWhitespace(line);
    if (lineIndent.startsWith(oldIndent)) out.push(fileIndent + line.slice(oldIndent.length));
    else out.push(fileIndent + line.replace(/^[ \t]+/, ''));
  }
  return out.join('\n');
}

function maybeUnescapeNewString(newString: string, content: string, matches: Match[]): string {
  if (!newString.includes('\\t') && !newString.includes('\\r')) return newString;
  const matchedRegions = matches.map(([s, e]) => content.slice(s, e)).join('');
  let out = newString;
  if (out.includes('\\t') && matchedRegions.includes('\t')) out = out.split('\\t').join('\t');
  if (out.includes('\\r') && matchedRegions.includes('\r')) out = out.split('\\r').join('\r');
  return out;
}

function applyReplacements(
  content: string, matches: Match[], newString: string, oldString: string | null,
): string {
  const sorted = [...matches].sort((a, b) => b[0] - a[0]);
  let result = content;
  for (const [start, end] of sorted) {
    const adjusted = oldString !== null
      ? reindentReplacement(content.slice(start, end), oldString, newString)
      : newString;
    result = result.slice(0, start) + adjusted + result.slice(end);
  }
  return result;
}

function strategyExact(content: string, pattern: string): Match[] {
  const matches: Match[] = [];
  let start = 0;
  for (;;) {
    const pos = content.indexOf(pattern, start);
    if (pos === -1) break;
    matches.push([pos, pos + pattern.length]);
    start = pos + 1;
  }
  return matches;
}

function strategyLineTrimmed(content: string, pattern: string): Match[] {
  const patternNormalized = pattern.split('\n').map((l) => l.trim()).join('\n');
  const contentLines = content.split('\n');
  const contentNormalizedLines = contentLines.map((l) => l.trim());
  return findNormalizedMatches(content, contentLines, contentNormalizedLines, patternNormalized);
}

function strategyWhitespaceNormalized(content: string, pattern: string): Match[] {
  const normalize = (s: string) => s.replace(/[ \t]+/g, ' ');
  const matchesInNormalized = strategyExact(normalize(content), normalize(pattern));
  if (matchesInNormalized.length === 0) return [];
  return mapNormalizedPositions(content, normalize(content), matchesInNormalized);
}

function strategyIndentationFlexible(content: string, pattern: string): Match[] {
  const contentLines = content.split('\n');
  const contentStrippedLines = contentLines.map((l) => l.replace(/^\s+/, ''));
  const patternNormalized = pattern.split('\n').map((l) => l.replace(/^\s+/, '')).join('\n');
  return findNormalizedMatches(content, contentLines, contentStrippedLines, patternNormalized);
}

function strategyEscapeNormalized(content: string, pattern: string): Match[] {
  const unescape = (s: string) => s.split('\\n').join('\n').split('\\t').join('\t').split('\\r').join('\r');
  const patternUnescaped = unescape(pattern);
  if (patternUnescaped === pattern) return [];
  return strategyExact(content, patternUnescaped);
}

function strategyTrimmedBoundary(content: string, pattern: string): Match[] {
  const patternLines = pattern.split('\n');
  if (patternLines.length === 0) return [];
  patternLines[0] = patternLines[0].trim();
  if (patternLines.length > 1) patternLines[patternLines.length - 1] = patternLines[patternLines.length - 1].trim();
  const modifiedPattern = patternLines.join('\n');
  const contentLines = content.split('\n');
  const matches: Match[] = [];
  const count = patternLines.length;
  for (let i = 0; i <= contentLines.length - count; i++) {
    const checkLines = contentLines.slice(i, i + count);
    checkLines[0] = checkLines[0].trim();
    if (checkLines.length > 1) checkLines[checkLines.length - 1] = checkLines[checkLines.length - 1].trim();
    if (checkLines.join('\n') === modifiedPattern) {
      matches.push(calculateLinePositions(contentLines, i, i + count, content.length));
    }
  }
  return matches;
}

function buildOrigToNormMap(original: string): number[] {
  const result: number[] = [];
  let normPos = 0;
  for (const ch of original) {
    result.push(normPos);
    const repl = UNICODE_MAP[ch];
    normPos += repl !== undefined ? repl.length : 1;
  }
  result.push(normPos);
  return result;
}

function mapPositionsNormToOrig(origToNorm: number[], normMatches: Match[]): Match[] {
  const normToOrigStart = new Map<number, number>();
  for (let origPos = 0; origPos < origToNorm.length - 1; origPos++) {
    const normPos = origToNorm[origPos];
    if (!normToOrigStart.has(normPos)) normToOrigStart.set(normPos, origPos);
  }
  const results: Match[] = [];
  const origLen = origToNorm.length - 1;
  for (const [normStart, normEnd] of normMatches) {
    if (!normToOrigStart.has(normStart)) continue;
    const origStart = normToOrigStart.get(normStart)!;
    let origEnd = origStart;
    while (origEnd < origLen && origToNorm[origEnd] < normEnd) origEnd++;
    results.push([origStart, origEnd]);
  }
  return results;
}

function strategyUnicodeNormalized(content: string, pattern: string): Match[] {
  const normPattern = unicodeNormalize(pattern);
  const normContent = unicodeNormalize(content);
  if (normContent === content && normPattern === pattern) return [];
  let normMatches = strategyExact(normContent, normPattern);
  if (normMatches.length === 0) normMatches = strategyLineTrimmed(normContent, normPattern);
  if (normMatches.length === 0) return [];
  const origToNorm = buildOrigToNormMap(content);
  return mapPositionsNormToOrig(origToNorm, normMatches);
}

function strategyBlockAnchor(content: string, pattern: string): Match[] {
  const normPattern = unicodeNormalize(pattern);
  const normContent = unicodeNormalize(content);
  const patternLines = normPattern.split('\n');
  if (patternLines.length < 2) return [];
  const firstLine = patternLines[0].trim();
  const lastLine = patternLines[patternLines.length - 1].trim();
  const normContentLines = normContent.split('\n');
  const origContentLines = content.split('\n');
  const count = patternLines.length;
  const potential: number[] = [];
  for (let i = 0; i <= normContentLines.length - count; i++) {
    if (normContentLines[i].trim() === firstLine && normContentLines[i + count - 1].trim() === lastLine) {
      potential.push(i);
    }
  }
  const matches: Match[] = [];
  const threshold = potential.length === 1 ? 0.5 : 0.7;
  for (const i of potential) {
    let similarity: number;
    if (count <= 2) similarity = 1.0;
    else {
      const contentMiddle = normContentLines.slice(i + 1, i + count - 1).join('\n');
      const patternMiddle = patternLines.slice(1, -1).join('\n');
      similarity = ratio(contentMiddle, patternMiddle);
    }
    if (similarity >= threshold) {
      matches.push(calculateLinePositions(origContentLines, i, i + count, content.length));
    }
  }
  return matches;
}

function strategyContextAware(content: string, pattern: string): Match[] {
  const patternLines = pattern.split('\n');
  const contentLines = content.split('\n');
  if (patternLines.length === 0) return [];
  const matches: Match[] = [];
  const count = patternLines.length;
  for (let i = 0; i <= contentLines.length - count; i++) {
    const block = contentLines.slice(i, i + count);
    let high = 0;
    for (let k = 0; k < count; k++) {
      if (ratio(patternLines[k].trim(), block[k].trim()) >= 0.8) high++;
    }
    if (high >= patternLines.length * 0.5) {
      matches.push(calculateLinePositions(contentLines, i, i + count, content.length));
    }
  }
  return matches;
}

function calculateLinePositions(
  contentLines: string[], startLine: number, endLine: number, contentLength: number,
): Match {
  let start = 0;
  for (let i = 0; i < startLine; i++) start += contentLines[i].length + 1;
  let end = 0;
  for (let i = 0; i < endLine; i++) end += contentLines[i].length + 1;
  end = Math.min(contentLength, end - 1);
  return [start, end];
}

function findNormalizedMatches(
  content: string, contentLines: string[], contentNormalizedLines: string[], patternNormalized: string,
): Match[] {
  const patternNormLines = patternNormalized.split('\n');
  const num = patternNormLines.length;
  const matches: Match[] = [];
  for (let i = 0; i <= contentNormalizedLines.length - num; i++) {
    const block = contentNormalizedLines.slice(i, i + num).join('\n');
    if (block === patternNormalized) {
      matches.push(calculateLinePositions(contentLines, i, i + num, content.length));
    }
  }
  return matches;
}

function mapNormalizedPositions(
  original: string, normalized: string, normalizedMatches: Match[],
): Match[] {
  if (normalizedMatches.length === 0) return [];
  const origToNorm: number[] = [];
  let origIdx = 0; let normIdx = 0;
  while (origIdx < original.length && normIdx < normalized.length) {
    if (original[origIdx] === normalized[normIdx]) {
      origToNorm.push(normIdx); origIdx++; normIdx++;
    } else if ((original[origIdx] === ' ' || original[origIdx] === '\t') && normalized[normIdx] === ' ') {
      origToNorm.push(normIdx); origIdx++;
      if (origIdx < original.length && original[origIdx] !== ' ' && original[origIdx] !== '\t') normIdx++;
    } else if (original[origIdx] === ' ' || original[origIdx] === '\t') {
      origToNorm.push(normIdx); origIdx++;
    } else {
      origToNorm.push(normIdx); origIdx++;
    }
  }
  while (origIdx < original.length) { origToNorm.push(normalized.length); origIdx++; }

  const normToOrigStart = new Map<number, number>();
  const normToOrigEnd = new Map<number, number>();
  for (let origPos = 0; origPos < origToNorm.length; origPos++) {
    const normPos = origToNorm[origPos];
    if (!normToOrigStart.has(normPos)) normToOrigStart.set(normPos, origPos);
    normToOrigEnd.set(normPos, origPos);
  }
  const out: Match[] = [];
  for (const [normStart, normEnd] of normalizedMatches) {
    let origStart: number;
    if (normToOrigStart.has(normStart)) origStart = normToOrigStart.get(normStart)!;
    else {
      origStart = origToNorm.findIndex((n) => n >= normStart);
      if (origStart === -1) origStart = original.length;
    }
    let origEnd: number;
    if (normToOrigEnd.has(normEnd - 1)) origEnd = normToOrigEnd.get(normEnd - 1)! + 1;
    else origEnd = origStart + (normEnd - normStart);
    while (origEnd < original.length && (original[origEnd] === ' ' || original[origEnd] === '\t')) origEnd++;
    out.push([origStart, Math.min(origEnd, original.length)]);
  }
  return out;
}

/** difflib.SequenceMatcher.ratio() equivalent (Ratcliff-Obershelp). */
export function ratio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1;
  const b2j = new Map<string, number[]>();
  for (let j = 0; j < b.length; j++) {
    const arr = b2j.get(b[j]);
    if (arr) arr.push(j); else b2j.set(b[j], [j]);
  }
  function longest(alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      const js = b2j.get(a[i]);
      if (js) {
        for (const j of js) {
          if (j < blo) continue;
          if (j >= bhi) break;
          const k = (j2len.get(j - 1) ?? 0) + 1;
          newj2len.set(j, k);
          if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
        }
      }
      j2len = newj2len;
    }
    return [besti, bestj, bestsize];
  }
  let matches = 0;
  const stack: [number, number, number, number][] = [[0, a.length, 0, b.length]];
  while (stack.length) {
    const [alo, ahi, blo, bhi] = stack.pop()!;
    const [i, j, k] = longest(alo, ahi, blo, bhi);
    if (k > 0) {
      matches += k;
      if (alo < i && blo < j) stack.push([alo, i, blo, j]);
      if (i + k < ahi && j + k < bhi) stack.push([i + k, ahi, j + k, bhi]);
    }
  }
  return (2 * matches) / total;
}

/** Closest-lines "did you mean?" snippet for no-match errors. */
export function findClosestLines(
  oldString: string, content: string, contextLines = 2, maxResults = 3,
): string {
  if (!oldString || !content) return '';
  const oldLines = oldString.split(/\r?\n/);
  const contentLines = content.split(/\r?\n/);
  if (oldLines.length === 0 || contentLines.length === 0) return '';
  let anchor = oldLines[0].trim();
  if (!anchor) {
    const candidates = oldLines.map((l) => l.trim()).filter(Boolean);
    if (candidates.length === 0) return '';
    anchor = candidates[0];
  }
  const scored: [number, number][] = [];
  for (let i = 0; i < contentLines.length; i++) {
    const stripped = contentLines[i].trim();
    if (!stripped) continue;
    const r = ratio(anchor, stripped);
    if (r > 0.3) scored.push([r, i]);
  }
  if (scored.length === 0) return '';
  scored.sort((a, b) => b[0] - a[0]);
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const [, lineIdx] of scored.slice(0, maxResults)) {
    const start = Math.max(0, lineIdx - contextLines);
    const end = Math.min(contentLines.length, lineIdx + oldLines.length + contextLines);
    const key = `${start},${end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const snippet: string[] = [];
    for (let j = 0; j < end - start; j++) {
      snippet.push(`${String(start + j + 1).padStart(4)}| ${contentLines[start + j]}`);
    }
    parts.push(snippet.join('\n'));
  }
  return parts.length ? parts.join('\n---\n') : '';
}

export function formatNoMatchHint(
  error: string | null, matchCount: number, oldString: string, content: string,
): string {
  if (matchCount !== 0) return '';
  if (!error || !error.startsWith('Could not find')) return '';
  const hint = findClosestLines(oldString, content);
  if (!hint) return '';
  return '\n\nDid you mean one of these sections?\n' + hint;
}
