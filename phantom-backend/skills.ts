// Skills — Agent Skills folders in the session's repo (`.agents/skills/<name>/`)
// merged with the image's baked system tier (repo shadows). READS are
// host-side over the session's checkout (the API owns that directory for git
// already; a read is safe and fast). WRITES go through the container like
// every repo mutation (the container user owns the repo's files — a host-side
// write would not, on Linux). The one implementation behind the /skills
// routes and the skill_* tools.
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SessionRow } from 'phantom-backend-sdk/schema';
import { repoDir } from 'phantom-backend-sdk';
import { Sandbox } from './workspace/sandbox.js';
import { ToolError } from './tools/envelope.js';
import { fuzzyFindAndReplace, formatNoMatchHint } from './tools/fuzzy.js';
import type { AppCtx } from './api/app.js';
import type { FsDeps } from './api/routes/fs.js';
import { SKILLS_DIR, mergeSkills, parseDescription, scanSkills } from '../core/skills/skills.js';
import { systemSkills, systemSkillTree } from './systemSkills.js';
import {
  MAX_FILE_BYTES, lintSkillMd, validateFilePath, validateSkillMd, validateSkillName,
} from '../core/skills/validate.js';

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

const skillDirHost = (ctx: AppCtx, sessionId: string, name: string) =>
  path.join(repoDir(ctx.paths, sessionId), SKILLS_DIR, name);
const skillDirContainer = (name: string) => `/workspace/repo/${SKILLS_DIR}/${name}`;

async function skillExists(ctx: AppCtx, sessionId: string, name: string): Promise<boolean> {
  return fsp.access(path.join(skillDirHost(ctx, sessionId, name), 'SKILL.md'))
    .then(() => true, () => false);
}

/** Every file under the skill folder except SKILL.md, relative paths. */
async function bundledFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string) => {
    const entries = await fsp.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(path.join(d, e.name), r);
      else if (r !== 'SKILL.md') out.push(r);
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
  const mk = await sandbox.run(['mkdir', '-p', dir]);
  if (mk.exitCode !== 0) throw new ToolError('invalid_args', `mkdir failed: ${mk.stderr.toString('utf8').slice(0, 200)}`);
  await sandbox.writeFile(abs, Buffer.from(content, 'utf8'));
}

/** The session's workspace image — the system skill tier lives inside it. */
async function imageFor(ctx: AppCtx, session: SessionRow): Promise<string> {
  const project = await ctx.projects.get(session.projectId);
  return String(await ctx.settings.resolve('container_image', project ? { projectId: project.id } : {}));
}

/** Every skill the session sees: a live scan of its working tree merged with
 *  the image's system tier (repo shadows). */
export async function listSkills(ctx: AppCtx, deps: FsDeps, session: SessionRow, workspaceId: string) {
  return { skills: mergeSkills(
    await scanSkills(repoDir(ctx.paths, workspaceId)),
    await systemSkills(deps.docker, await imageFor(ctx, session))) };
}

/** The whole SKILL.md plus the names of its bundled files in ONE answer;
 *  `file` fetches one bundled file instead. */
export async function loadSkill(ctx: AppCtx, deps: FsDeps, session: SessionRow, workspaceId: string,
  name: string, file?: string): Promise<unknown> {
  const nameErr = validateSkillName(name);
  if (nameErr) throw new ToolError('invalid_args', nameErr);
  const dir = skillDirHost(ctx, workspaceId, name);
  if (!(await skillExists(ctx, workspaceId, name))) {
    // Not in the repo — fall through to the image's system tier (repo
    // shadows system, so this only answers un-shadowed names).
    const sys = (await systemSkillTree(deps.docker, await imageFor(ctx, session))).get(name);
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
    const content = await fsp.readFile(path.join(dir, file), 'utf8')
      .catch(() => { throw new ToolError('skill_not_found', `no file '${file}' in skill '${name}'`); });
    return { name, file, content };
  }
  const instructions = await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8');
  return { name, instructions, files: await bundledFiles(dir) };
}

/** Every write, validated, through the container. */
export async function manageSkill(ctx: AppCtx, deps: FsDeps, session: SessionRow, workspaceId: string, body: ManageBody): Promise<unknown> {
  const nameErr = validateSkillName(body.name);
  if (nameErr) throw new ToolError('invalid_args', nameErr);
  const project = await ctx.projects.get(session.projectId);
  let container;
  try {
    container = await deps.containers.ensure(workspaceId, project);
  } catch (e) {
    throw new ToolError('container_start_failed', (e as Error).message, true);
  }
  const sandbox = new Sandbox(deps.docker, container);
  // Writes reach the REPO tier only. When the name exists solely in the
  // image's system tier, say so — "no skill" would gaslight an agent that
  // just saw it in skill_list.
  const systemHas = !(await skillExists(ctx, workspaceId, body.name))
    && (await systemSkillTree(deps.docker, await imageFor(ctx, session))).has(body.name);
  return manage(ctx, sandbox, workspaceId, body, systemHas);
}

async function manage(ctx: AppCtx, sandbox: Sandbox, workspaceId: string, body: ManageBody,
  systemHas = false): Promise<unknown> {
  const { action, name } = body;
  const exists = await skillExists(ctx, workspaceId, name);
  const hostDir = skillDirHost(ctx, workspaceId, name);
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
      const current = await fsp.readFile(path.join(hostDir, rel), 'utf8')
        .catch(() => { throw new ToolError('skill_not_found', `no file '${rel}' in skill '${name}'`); });
      const r = fuzzyFindAndReplace(current, body.old_string, body.new_string, body.replace_all ?? false);
      if (r.error) {
        throw new ToolError('invalid_args', r.error + formatNoMatchHint(r.error, r.count, body.old_string, current));
      }
      if (rel === 'SKILL.md') {
        const vErr = validateSkillMd(name, r.content);
        if (vErr) throw new ToolError('invalid_args', `Patch would break SKILL.md: ${vErr}`);
      }
      await writeViaContainer(sandbox, name, rel, r.content);
      return { message: `Patched ${rel} in '${name}' (${r.count} replacement${r.count === 1 ? '' : 's'}, ${r.strategy}).` };
    }

    case 'delete': {
      if (!exists) throw notFound();
      const r = await sandbox.run(['rm', '-rf', skillDirContainer(name)]);
      if (r.exitCode !== 0) throw new ToolError('invalid_args', `delete failed: ${r.stderr.toString('utf8').slice(0, 200)}`);
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
      const present = await fsp.access(path.join(hostDir, body.file_path!)).then(() => true, () => false);
      if (!present) throw new ToolError('skill_not_found', `no file '${body.file_path}' in skill '${name}'`);
      const r = await sandbox.run(['rm', '-f', `${skillDirContainer(name)}/${body.file_path}`]);
      if (r.exitCode !== 0) throw new ToolError('invalid_args', `remove failed: ${r.stderr.toString('utf8').slice(0, 200)}`);
      return { message: `Removed ${body.file_path} from skill '${name}'.` };
    }

    default:
      throw new ToolError('invalid_args', `unknown action '${String(action)}'`);
  }
}
