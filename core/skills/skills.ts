// Skills — Agent Skills folders (agentskills.io): `<root>/.agents/skills/
// <name>/SKILL.md`, one level deep, plus optional bundled files under
// references/ templates/ scripts/ assets/. Two tiers exist, both
// server-side: the repo's (scanned here, host-side — reads are safe host-side,
// writes never are) and the system skills baked into the session image at
// /opt/skills/ (phantom-backend/systemSkills.ts); repo wins a collision.
// There is no personal/laptop tier. A skill's identity is its FOLDER name; the frontmatter `name`
// must match on create (validate.ts) but discovery is lenient — pi's rule —
// so a hand-authored mismatch still lists under the folder name.
import fsp from 'node:fs/promises';
import path from 'node:path';

export const SKILLS_DIR = '.agents/skills';

export interface SkillMeta {
  name: string;
  description: string;
}

/** Frontmatter split: `---\n…\n---` at the top, BOM tolerated (a user-edited
 *  file often carries one — it cost hermes a sweep to learn that). Returns
 *  null when there is no frontmatter fence. */
export function splitFrontmatter(md: string): { fm: string; body: string } | null {
  const clean = md.replace(/^﻿/, '');
  const m = clean.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return null;
  return { fm: m[1], body: clean.slice(m[0].length) };
}

/** The frontmatter `description`, single-line or YAML block scalar
 *  (`description: |` / `>` — vendor skills use these). Multi-line values are
 *  flattened to one line. Null when absent or empty. */
export function parseDescription(md: string): string | null {
  const parts = splitFrontmatter(md);
  if (!parts) return null;
  const lines = parts.fm.split(/\r?\n/);
  const i = lines.findIndex((l) => /^description:/.test(l));
  if (i < 0) return null;
  const head = lines[i].replace(/^description:\s*/, '').trim();
  if (/^[|>][+-]?\d*$/.test(head)) {
    const out: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') continue;
      if (/^\s/.test(l)) out.push(l.trim());
      else break;
    }
    const v = out.join(' ').replace(/\s+/g, ' ').trim();
    return v || null;
  }
  const v = head.replace(/^["']|["']$/g, '').trim();
  return v || null;
}

/** The frontmatter `name` (single-line). Null when absent. */
export function parseName(md: string): string | null {
  const parts = splitFrontmatter(md);
  if (!parts) return null;
  const m = parts.fm.match(/^name:\s*(.+)$/m);
  const v = m ? m[1].trim().replace(/^["']|["']$/g, '').trim() : '';
  return v || null;
}

/** Scan one skills root (`<root>/.agents/skills`): every direct child folder
 *  with a SKILL.md that has a description. Plain filesystem reads — works on
 *  the host checkout (the API) and on a local dir (the TUI) alike. A missing
 *  root is an empty list, never an error. Sorted by name for a stable prompt. */
export async function scanSkills(root: string): Promise<SkillMeta[]> {
  const dir = path.join(root, SKILLS_DIR);
  let entries: string[];
  try {
    entries = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name);
  } catch {
    return [];
  }
  const out: SkillMeta[] = [];
  for (const name of entries) {
    const md = await fsp.readFile(path.join(dir, name, 'SKILL.md'), 'utf8').catch(() => null);
    if (md === null) continue;
    const description = parseDescription(md);
    if (!description) continue;
    out.push({ name, description });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Merge skill lists by precedence: earlier lists win on a name collision
 *  (call as merge(repo, personal) — the repo's skill shadows the personal
 *  one). */
export function mergeSkills(...lists: SkillMeta[][]): SkillMeta[] {
  const seen = new Set<string>();
  const out: SkillMeta[] = [];
  for (const list of lists) for (const s of list) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    out.push(s);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
