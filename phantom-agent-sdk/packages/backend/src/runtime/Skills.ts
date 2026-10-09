// Skills — Agent Skills folders in the session's repo (`.agents/skills/<name>/`)
// merged with the image's baked system tier (repo shadows). READS go to the
// workspace's host (its files, over the checkout — a read is safe and fast).
// WRITES go through the container like every repo mutation (the container
// user owns the repo's files — a host-side write would not, on Linux). The
// one implementation behind the /skills routes and the skill_* tools.
import type { SessionRow } from '../storage/schema.js';
import type { Sandbox } from './Sandbox.js';
import type { WorkspaceFiles } from './WorkspaceHost.js';
import { ToolError } from '../tools/envelope.js';
import { fuzzyFindAndReplace, formatNoMatchHint } from '../tools/fuzzy.js';
import type { PhantomBackend } from '../PhantomBackend.js';
import { SKILLS_DIR, mergeSkills, parseDescription, scanSkillsIn } from '../skills/skills.js';
import { systemSkills, systemSkillTree } from './SystemSkills.js';
import { scopeOf } from '../lib/scopes.js';
import {
  MAX_FILE_BYTES, lintSkillMd, validateFilePath, validateSkillMd, validateSkillName,
} from '../skills/validate.js';

export interface ManageBody {
  action: 'create' | 'edit' | 'patch' | 'delete' | 'write_file' | 'remove_file';
  name: string;
  content?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
  file_path?: string;
  file_content?: string;
}

/** The skill's folder, as a path inside the workspace (its host's files). */
const skillDir = (name: string) => `repo/${SKILLS_DIR}/${name}`;
const skillDirContainer = (name: string) => `/workspace/repo/${SKILLS_DIR}/${name}`;

const filesOf = async (ctx: PhantomBackend, workspaceId: string): Promise<WorkspaceFiles> =>
  (await ctx.sessionHosts.of(workspaceId)).files(workspaceId);

async function skillExists(files: WorkspaceFiles, name: string): Promise<boolean> {
  return (await files.stat(`${skillDir(name)}/SKILL.md`)) !== null;
}

const readText = async (files: WorkspaceFiles, rel: string): Promise<string | null> =>
  (await files.read(rel))?.toString('utf8') ?? null;

/** Every file under the skill folder except SKILL.md, relative paths. */
async function bundledFiles(files: WorkspaceFiles, dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string) => {
    const entries = (await files.list(dir).catch(() => null)) ?? [];
    for (const entry of entries) {
      const relativePath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.type === 'dir') await walk(`${dir}/${entry.name}`, relativePath);
      else if (relativePath !== 'SKILL.md') out.push(relativePath);
    }
  };
  await walk(dir, '');
  return out.sort();
}

/** Write one file into the skill folder via the container (the container user
 *  owns the repo's files — a host-side write would not, on Linux). */
async function writeViaContainer(sandbox: Sandbox, name: string, rel: string, content: string): Promise<void> {
  const abs = `${skillDirContainer(name)}/${rel}`;
  const dir = abs.slice(0, abs.lastIndexOf('/'));
  const made = await sandbox.run(['mkdir', '-p', dir]);
  if (made.exitCode !== 0) throw new ToolError('invalid_args', `mkdir failed: ${made.stderr.toString('utf8').slice(0, 200)}`);
  await sandbox.writeFile(abs, Buffer.from(content, 'utf8'));
}

/** The session's workspace image — the system skill tier lives inside it. */
async function imageFor(ctx: PhantomBackend, session: SessionRow): Promise<string> {
  const project = await ctx.projects.get(session.projectId);
  return String(await ctx.settings.resolve('container_image', project ? scopeOf(project) : {}));
}

/** Every skill the session sees: a live scan of its working tree merged with
 *  the image's system tier (repo shadows). */
export async function listSkills(ctx: PhantomBackend, session: SessionRow, workspaceId: string) {
  return { skills: mergeSkills(
    await scanSkillsIn(await filesOf(ctx, workspaceId)),
    await systemSkills(ctx.docker, await imageFor(ctx, session))) };
}

/** The whole SKILL.md plus the names of its bundled files in ONE answer;
 *  `file` fetches one bundled file instead. */
export async function loadSkill(ctx: PhantomBackend, session: SessionRow, workspaceId: string,
  name: string, file?: string): Promise<unknown> {
  const nameErr = validateSkillName(name);
  if (nameErr) throw new ToolError('invalid_args', nameErr);
  const files = await filesOf(ctx, workspaceId);
  const dir = skillDir(name);
  if (!(await skillExists(files, name))) {
    // Not in the repo — fall through to the image's system tier (repo
    // shadows system, so this only answers un-shadowed names).
    const sys = (await systemSkillTree(ctx.docker, await imageFor(ctx, session))).get(name);
    if (!sys) throw new ToolError('skill_not_found', `no skill '${name}' in ${SKILLS_DIR}/ or the image's system skills`);
    if (file) {
      const fErr = validateFilePath(file);
      if (fErr) throw new ToolError('invalid_args', fErr);
      const content = sys.files.get(file);
      if (content === undefined) throw new ToolError('skill_not_found', `no file '${file}' in skill '${name}'`);
      return { name, file, content };
    }
    return { name, instructions: sys.md, files: [...sys.files.keys()].sort() };
  }
  if (file) {
    const fErr = validateFilePath(file);
    if (fErr) throw new ToolError('invalid_args', fErr);
    const content = await readText(files, `${dir}/${file}`).catch(() => null);
    if (content === null) throw new ToolError('skill_not_found', `no file '${file}' in skill '${name}'`);
    return { name, file, content };
  }
  const instructions = (await readText(files, `${dir}/SKILL.md`)) ?? '';
  return { name, instructions, files: await bundledFiles(files, dir) };
}

/** Every write, validated, through the container. */
export async function manageSkill(ctx: PhantomBackend, session: SessionRow, workspaceId: string, body: ManageBody): Promise<unknown> {
  const nameErr = validateSkillName(body.name);
  if (nameErr) throw new ToolError('invalid_args', nameErr);
  const project = await ctx.projects.get(session.projectId);
  let sandbox: Sandbox;
  try {
    sandbox = (await ctx.sessionContainers.ensure(workspaceId, project)).sandbox(workspaceId);
  } catch (error) {
    throw new ToolError('container_start_failed', (error as Error).message, true);
  }
  const files = await filesOf(ctx, workspaceId);
  // Writes reach the REPO tier only. When the name exists solely in the
  // image's system tier, say so — "no skill" would gaslight an agent that
  // just saw it in skill_list.
  const systemHas = !(await skillExists(files, body.name))
    && (await systemSkillTree(ctx.docker, await imageFor(ctx, session))).has(body.name);
  return manage(files, sandbox, body, systemHas);
}

async function manage(files: WorkspaceFiles, sandbox: Sandbox, body: ManageBody,
  systemHas = false): Promise<unknown> {
  const { action, name } = body;
  const exists = await skillExists(files, name);
  const hostDir = skillDir(name);
  const notFound = () => new ToolError('skill_not_found', systemHas
    ? `'${name}' is a read-only system skill (baked into the workspace image). To change what the agent ` +
      `sees, create a repo skill named '${name}' — it shadows the system one.`
    : `no skill '${name}'`);

  switch (action) {
    case 'create':
    case 'edit': {
      if (!body.content) throw new ToolError('invalid_args', `'content' (full SKILL.md) is required for '${action}'.`);
      if (action === 'create' && exists) {
        throw new ToolError('invalid_args', `Skill '${name}' already exists — use 'edit' or 'patch'.`);
      }
      if (action === 'edit' && !exists) throw notFound();
      const vErr = validateSkillMd(name, body.content);
      if (vErr) throw new ToolError('invalid_args', vErr);
      await writeViaContainer(sandbox, name, 'SKILL.md', body.content);
      const warnings = action === 'create' ? lintSkillMd(body.content) : [];
      return { message: `Skill '${name}' ${action === 'create' ? 'created' : 'updated'}.`,
        description: parseDescription(body.content), ...(warnings.length ? { warnings } : {}) };
    }

    case 'patch': {
      if (!exists) throw notFound();
      if (!body.old_string) throw new ToolError('invalid_args', "'old_string' is required for 'patch'.");
      if (body.new_string === undefined) {
        throw new ToolError('invalid_args', "'new_string' is required for 'patch' (empty string deletes the match).");
      }
      let rel = 'SKILL.md';
      if (body.file_path) {
        const fErr = validateFilePath(body.file_path);
        if (fErr) throw new ToolError('invalid_args', fErr);
        rel = body.file_path;
      }
      const current = await readText(files, `${hostDir}/${rel}`).catch(() => null);
      if (current === null) throw new ToolError('skill_not_found', `no file '${rel}' in skill '${name}'`);
      const replaced = fuzzyFindAndReplace(current, body.old_string, body.new_string, body.replace_all ?? false);
      if (replaced.error) {
        throw new ToolError('invalid_args', replaced.error + formatNoMatchHint(replaced.error, replaced.count, body.old_string, current));
      }
      if (rel === 'SKILL.md') {
        const vErr = validateSkillMd(name, replaced.content);
        if (vErr) throw new ToolError('invalid_args', `Patch would break SKILL.md: ${vErr}`);
      }
      await writeViaContainer(sandbox, name, rel, replaced.content);
      return { message: `Patched ${rel} in '${name}' (${replaced.count} replacement${replaced.count === 1 ? '' : 's'}, ${replaced.strategy}).` };
    }

    case 'delete': {
      if (!exists) throw notFound();
      const removed = await sandbox.run(['rm', '-rf', skillDirContainer(name)]);
      if (removed.exitCode !== 0) throw new ToolError('invalid_args', `delete failed: ${removed.stderr.toString('utf8').slice(0, 200)}`);
      return { message: `Skill '${name}' deleted.` };
    }

    case 'write_file': {
      if (!exists) throw notFound();
      const fErr = validateFilePath(body.file_path ?? '');
      if (fErr) throw new ToolError('invalid_args', fErr);
      if (body.file_content === undefined) throw new ToolError('invalid_args', "'file_content' is required for 'write_file'.");
      if (Buffer.byteLength(body.file_content, 'utf8') > MAX_FILE_BYTES) {
        throw new ToolError('invalid_args', `file exceeds ${MAX_FILE_BYTES} bytes.`);
      }
      await writeViaContainer(sandbox, name, body.file_path!, body.file_content);
      return { message: `Wrote ${body.file_path} to skill '${name}'.` };
    }

    case 'remove_file': {
      if (!exists) throw notFound();
      const fErr = validateFilePath(body.file_path ?? '');
      if (fErr) throw new ToolError('invalid_args', fErr);
      const present = (await files.stat(`${hostDir}/${body.file_path!}`)) !== null;
      if (!present) throw new ToolError('skill_not_found', `no file '${body.file_path}' in skill '${name}'`);
      const removed = await sandbox.run(['rm', '-f', `${skillDirContainer(name)}/${body.file_path}`]);
      if (removed.exitCode !== 0) throw new ToolError('invalid_args', `remove failed: ${removed.stderr.toString('utf8').slice(0, 200)}`);
      return { message: `Removed ${body.file_path} from skill '${name}'.` };
    }

    default:
      throw new ToolError('invalid_args', `unknown action '${String(action)}'`);
  }
}
