// Line-level unified diff (LCS-based), 3 lines of context per hunk. The edit
// tool returns this so the model SEES what actually changed — the disclosure
// half of apply-with-disclosure.

type Op = { type: 'ctx' | 'del' | 'add'; aIndex?: number; bIndex?: number };

function lcsDiff(a: string[], b: string[]): Op[] {
  // Myers would be fancier; LCS via DP is fine at file scale and obviously correct.
  const aLength = a.length, bLength = b.length;
  // For very large files fall back to a trivial full-replace diff rather than
  // an O(n*m) table nobody can afford.
  if (aLength * bLength > 4_000_000) {
    return [
      ...a.map((_, i) => ({ type: 'del' as const, aIndex: i })),
      ...b.map((_, j) => ({ type: 'add' as const, bIndex: j })),
    ];
  }
  const table: Uint32Array[] = Array.from({ length: aLength + 1 }, () => new Uint32Array(bLength + 1));
  for (let i = aLength - 1; i >= 0; i--) {
    for (let j = bLength - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < aLength && j < bLength) {
    if (a[i] === b[j]) { ops.push({ type: 'ctx', aIndex: i, bIndex: j }); i++; j++; }
    else if (table[i + 1][j] >= table[i][j + 1]) { ops.push({ type: 'del', aIndex: i }); i++; }
    else { ops.push({ type: 'add', bIndex: j }); j++; }
  }
  while (i < aLength) { ops.push({ type: 'del', aIndex: i }); i++; }
  while (j < bLength) { ops.push({ type: 'add', bIndex: j }); j++; }
  return ops;
}

export function unifiedDiff(path: string, a: string, b: string): string {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  const ops = lcsDiff(aLines, bLines);
  const CTX = 3;

  type Hunk = { aStart: number; bStart: number; aCount: number; bCount: number; lines: string[] };
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let ctxTrail = 0;

  const flush = () => {
    if (!cur) return;
    while (ctxTrail > CTX) { cur.lines.pop(); cur.aCount--; cur.bCount--; ctxTrail--; }
    hunks.push(cur); cur = null; ctxTrail = 0;
  };

  for (let k = 0; k < ops.length; k++) {
    const operation = ops[k];
    if (operation.type === 'ctx') {
      if (cur) {
        cur.lines.push(` ${aLines[operation.aIndex!]}`);
        cur.aCount++; cur.bCount++; ctxTrail++;
        if (ctxTrail > CTX * 2) flush();
      }
      continue;
    }
    if (!cur) {
      const back: Op[] = [];
      let j = k - 1;
      while (j >= 0 && ops[j].type === 'ctx' && back.length < CTX) { back.unshift(ops[j]); j--; }
      cur = {
        aStart: (back[0]?.aIndex ?? operation.aIndex ?? (ops[k - 1]?.aIndex ?? 0) + 1) + 1,
        bStart: (back[0]?.bIndex ?? operation.bIndex ?? (ops[k - 1]?.bIndex ?? 0) + 1) + 1,
        aCount: back.length, bCount: back.length,
        lines: back.map((operation) => ` ${aLines[operation.aIndex!]}`),
      };
    }
    ctxTrail = 0;
    if (operation.type === 'del') { cur.lines.push(`-${aLines[operation.aIndex!]}`); cur.aCount++; }
    else { cur.lines.push(`+${bLines[operation.bIndex!]}`); cur.bCount++; }
  }
  flush();

  if (!hunks.length) return '';
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    out.push(`@@ -${hunk.aStart},${hunk.aCount} +${hunk.bStart},${hunk.bCount} @@`);
    out.push(...hunk.lines);
  }
  return out.join('\n');
}
