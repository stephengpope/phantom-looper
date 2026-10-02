// Skill validation — the reason skill writes go through a tool instead of
// bare write/edit: one bad description quietly degrades every future
// session's prompt. Limits mirror the Agent Skills spec (agentskills.io),
// same as hermes's skill_manager and knack.
import { parseDescription, parseName, splitFrontmatter } from './skills.js';

export const MAX_NAME = 64;
export const MAX_DESCRIPTION = 1024;
export const MAX_SKILL_CONTENT = 100_000; // chars, SKILL.md
export const MAX_FILE_BYTES = 1_048_576; // 1 MiB, bundled files
export const FILE_SUBDIRS = ['references', 'templates', 'scripts', 'assets'] as const;

// Spec name rule: 1-64 chars, lowercase a-z/0-9, single hyphens, no
// leading/trailing/consecutive hyphens. The name IS the folder name.
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Bundled-file paths: an allowed subdir + a safe relative path. The charset
// also keeps the value safe as a single argv element.
const FILE_PATH_RE = /^[A-Za-z0-9._/-]+$/;

export function validateSkillName(name: string): string | null {
  if (!name) return 'Skill name is required.';
  if (name.length > MAX_NAME) return `Skill name exceeds ${MAX_NAME} characters.`;
  if (!NAME_RE.test(name)) {
    return 'Invalid skill name. Use lowercase letters, numbers, and single hyphens ' +
      "(e.g. 'pdf-tools') — no leading/trailing or doubled hyphens, no spaces.";
  }
  return null;
}

/** Validate a full SKILL.md for create/edit: frontmatter fence, a `name`
 *  matching the skill's folder, a description within the spec limit, a
 *  non-empty body, the size cap. Returns null when good, else the error. */
export function validateSkillMd(skillName: string, content: string): string | null {
  if (content.length > MAX_SKILL_CONTENT) {
    return `SKILL.md exceeds ${MAX_SKILL_CONTENT} characters.`;
  }
  const parts = splitFrontmatter(content);
  if (!parts) return "SKILL.md must start with YAML frontmatter delimited by '---'.";
  const name = parseName(content);
  if (!name) return "Frontmatter must include a 'name'.";
  if (name !== skillName) {
    return `Frontmatter name '${name}' must match the skill's folder name '${skillName}'.`;
  }
  const description = parseDescription(content);
  if (!description) return "Frontmatter must include a non-empty 'description'.";
  if (description.length > MAX_DESCRIPTION) {
    return `description exceeds ${MAX_DESCRIPTION} characters.`;
  }
  if (!parts.body.trim()) {
    return 'SKILL.md must have instructions in the body after the frontmatter.';
  }
  return null;
}

/** Bundled-file path rule: under references/ templates/ scripts/ assets/,
 *  no '..', safe charset. */
export function validateFilePath(filePath: string): string | null {
  if (!filePath) return 'file_path is required.';
  if (filePath.includes('..')) return "file_path must not contain '..'.";
  if (!FILE_PATH_RE.test(filePath)) return 'file_path contains invalid characters.';
  const top = filePath.split('/')[0];
  if (!(FILE_SUBDIRS as readonly string[]).includes(top)) {
    return `file_path must be under one of: ${FILE_SUBDIRS.join('/, ')}/.`;
  }
  return null;
}

/** Advisory warnings — hermes's linter idea, the light version: returned with
 *  a successful write, never blocking. */
export function lintSkillMd(content: string): string[] {
  const warnings: string[] = [];
  const description = parseDescription(content) ?? '';
  if (description.length < 20) {
    warnings.push('description is very short — say what the skill does AND when to use it.');
  }
  const body = splitFrontmatter(content)?.body ?? '';
  for (const m of body.matchAll(/\]\(((?:references|templates|scripts|assets)\/[^)]+)\)/g)) {
    warnings.push(`links to bundled file '${m[1]}' — make sure it exists (write_file adds it).`);
  }
  return warnings;
}
