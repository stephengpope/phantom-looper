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
import type { WorkspaceFiles } from '../runtime/WorkspaceHost.js';

export const SKILLS_DIR = '.agents/skills';

export interface SkillMeta {
  name: string;
  description: string;
}

/** Frontmatter split: `---\n…\n---` at the top, BOM tolerated (a user-edited
 *  file often carries one — it cost hermes a sweep to learn that). Returns
 *  null when there is no frontmatter fence. */
export function splitFrontmatter(markdown: string): { fm: string; body: string } | null {
  const clean = markdown.replace(/^﻿/, '');
  const match = clean.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!match) return null;
  return { fm: match[1], body: clean.slice(match[0].length) };
}

/** The frontmatter `description`, single-line or YAML block scalar
 *  (`description: |` / `>` — vendor skills use these). Multi-line values are
 *  flattened to one line. Null when absent or empty. */
export function parseDescription(markdown: string): string | null {
  const parts = splitFrontmatter(markdown);
  if (!parts) return null;
  const lines = parts.fm.split(/\r?\n/);
  const i = lines.findIndex((line) => /^description:/.test(line));
  if (i < 0) return null;
  const head = lines[i].replace(/^description:\s*/, '').trim();
  if (/^[|>][+-]?\d*$/.test(head)) {
    const out: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === '') continue;
      if (/^\s/.test(line)) out.push(line.trim());
      else break;
    }
    const value = out.join(' ').replace(/\s+/g, ' ').trim();
    return value || null;
  }
  const value = head.replace(/^["']|["']$/g, '').trim();
  return value || null;
}

/** The frontmatter `name` (single-line). Null when absent. */
export function parseName(markdown: string): string | null {
  const parts = splitFrontmatter(markdown);
  if (!parts) return null;
  const match = parts.fm.match(/^name:\s*(.+)$/m);
  const value = match ? match[1].trim().replace(/^["']|["']$/g, '').trim() : '';
  return value || null;
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
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink()).map((entry) => entry.name);
  } catch (error) {
    // No directory is the normal case (a repo without skills); anything else
    // is a real read failure and must not read as "no skills".
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw new Error(`could not read the skills directory ${dir}: ${(error as Error).message}`);
  }
  const out: SkillMeta[] = [];
  for (const name of entries) {
    const markdown = await fsp.readFile(path.join(dir, name, 'SKILL.md'), 'utf8').catch(() => null);
    if (markdown === null) continue;
    const description = parseDescription(markdown);
    if (!description) continue;
    out.push({ name, description });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** The same scan over a workspace's files on its host: `base` is the repo's
 *  path inside the workspace (`repo`). */
export async function scanSkillsIn(files: WorkspaceFiles, base = 'repo'): Promise<SkillMeta[]> {
  const dir = `${base}/${SKILLS_DIR}`;
  const entries = await files.list(dir);
  if (entries === null) return [];
  const out: SkillMeta[] = [];
  for (const entry of entries) {
    if (entry.kind !== 'dir' && entry.kind !== 'link') continue;
    const markdown = await files.read(`${dir}/${entry.name}/SKILL.md`).catch(() => null);
    if (markdown === null) continue;
    const description = parseDescription(markdown.toString('utf8'));
    if (!description) continue;
    out.push({ name: entry.name, description });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Merge skill lists by precedence: earlier lists win on a name collision
 *  (call as merge(repo, personal) — the repo's skill shadows the personal
 *  one). */
export function mergeSkills(...lists: SkillMeta[][]): SkillMeta[] {
  const seen = new Set<string>();
  const out: SkillMeta[] = [];
  for (const list of lists) for (const skill of list) {
    if (seen.has(skill.name)) continue;
    seen.add(skill.name);
    out.push(skill);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
