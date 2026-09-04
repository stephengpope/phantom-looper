// The skills surface — Agent Skills folders in the session's repo
// (`.agents/skills/<name>/`). READS are host-side over the session's checkout
// (the API owns that directory for git already; a read is safe and fast).
// WRITES go through the container like every repo mutation (no lock — tools
// take none; one user drives git). Session travels
// in the same header as the tool routes.
import type { FastifyInstance, FastifyReply } from 'fastify';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { workspaces, type SessionRow } from '../../db/schema.js';
import { getSession, touchSession } from '../../sessions.js';
import { repoDir } from '../../pool/paths.js';
import { Sandbox } from '../../workspace/sandbox.js';
import { ToolError } from '../../tools/envelope.js';
import { fuzzyFindAndReplace, formatNoMatchHint } from '../../tools/fuzzy.js';
import { ok, err, type AppCtx } from '../app.js';
import { SESSION_HEADER, type FsDeps } from './fs.js';
import { SKILLS_DIR, mergeSkills, parseDescription, scanSkills } from '../../../core/skills/skills.js';
import { systemSkills, systemSkillTree } from '../../systemSkills.js';
import { resolve } from '../../settings.js';
import {
  MAX_FILE_BYTES, lintSkillMd, validateFilePath, validateSkillMd, validateSkillName,
} from '../../../core/skills/validate.js';

const TAG = { tags: ['skills'] };

const STATUS: Record<string, number> = {
  session_not_found: 404, session_destroyed: 410, skill_not_found: 404,
  invalid_args: 400, busy: 409, container_start_failed: 503,
};

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

/** Resolve the session from the header — same contract as the tool routes. */
async function requireSession(ctx: AppCtx, headers: Record<string, unknown>): Promise<SessionRow> {
  const id = String(headers[SESSION_HEADER] ?? '');
  if (!id) throw new ToolError('session_not_found', `missing ${SESSION_HEADER} header`);
  const session = await getSession(ctx.db, id);
  if (!session) throw new ToolError('session_not_found', id);
  if (session.status !== 'active') throw new ToolError('session_destroyed', `session is ${session.status}`);
  void touchSession(ctx.db, id);
  return session;
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
async function writeViaContainer(ws: Sandbox, name: string, rel: string, content: string): Promise<void> {
  const abs = `${skillDirContainer(name)}/${rel}`;
  const dir = abs.slice(0, abs.lastIndexOf('/'));
  const mk = await ws.run(['mkdir', '-p', dir]);
  if (mk.exitCode !== 0) throw new ToolError('invalid_args', `mkdir failed: ${mk.stderr.toString('utf8').slice(0, 200)}`);
  await ws.writeFile(abs, Buffer.from(content, 'utf8'));
}

export function skillsRoutes(app: FastifyInstance, ctx: AppCtx, deps: FsDeps) {
  const sessionHeader = {
    type: 'object',
    properties: { [SESSION_HEADER]: { type: 'string', description: 'Session id (ULID). Required.' } },
  };
  const handle = (reply: FastifyReply, e: unknown) => {
    if (e instanceof ToolError) return reply.code(STATUS[e.code] ?? 400).send(err(e.code, e.message, e.retryable));
    throw e;
  };

  /** The session's workspace image — the system skill tier lives inside it. */
  const imageFor = async (session: SessionRow): Promise<string> => {
    const rows = await ctx.db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId));
    return String(await resolve(ctx.db, 'container_image', { workspace: rows[0] }));
  };

  // List — live scan of the session's working tree, merged with the image's
  // baked system tier (repo shadows). The prompt's list is the snapshot from
  // session creation; this is the current truth.
  app.get('/skills', { schema: { ...TAG, summary: "The session's skills, live (repo + image system tier)",
    headers: sessionHeader,
    response: { 200: { type: 'object', properties: { ok: { type: 'boolean' }, data: {
      type: 'object', properties: { skills: { type: 'array', items: {
        type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' } } } } } } } } } } },
  async (req, reply) => {
    try {
      const session = await requireSession(ctx, req.headers);
      return ok({ skills: mergeSkills(
        await scanSkills(repoDir(ctx.paths, session.folderId ?? session.id)),
        await systemSkills(deps.docker, await imageFor(session))) });
    } catch (e) { return handle(reply, e); }
  });

  // Load — the whole SKILL.md plus the names of its bundled files in ONE
  // call; `?file=` fetches one bundled file instead.
  app.get<{ Params: { name: string }; Querystring: { file?: string } }>(
    '/skills/:name', { schema: { ...TAG, summary: "One skill's instructions + bundled file names",
      headers: sessionHeader,
      params: { type: 'object', properties: { name: { type: 'string' } } },
      querystring: { type: 'object', properties: { file: { type: 'string', description: 'bundled file to fetch instead (references/… etc.)' } } } } },
    async (req, reply) => {
      try {
        const session = await requireSession(ctx, req.headers);
        const name = req.params.name;
        const nameErr = validateSkillName(name);
        if (nameErr) throw new ToolError('invalid_args', nameErr);
        const dir = skillDirHost(ctx, session.folderId ?? session.id, name);
        if (!(await skillExists(ctx, session.folderId ?? session.id, name))) {
          // Not in the repo — fall through to the image's system tier
          // (repo shadows system, so this only answers un-shadowed names).
          const sys = (await systemSkillTree(deps.docker, await imageFor(session))).get(name);
          if (!sys) {
            throw new ToolError('skill_not_found',
              `no skill '${name}' in ${SKILLS_DIR}/ or the image's system skills`);
          }
          if (req.query.file) {
            const fErr = validateFilePath(req.query.file);
            if (fErr) throw new ToolError('invalid_args', fErr);
            const content = sys.files.get(req.query.file);
            if (content === undefined) {
              throw new ToolError('skill_not_found', `no file '${req.query.file}' in skill '${name}'`);
            }
            return ok({ name, file: req.query.file, content });
          }
          return ok({ name, instructions: sys.md, files: [...sys.files.keys()].sort() });
        }
        if (req.query.file) {
          const fErr = validateFilePath(req.query.file);
          if (fErr) throw new ToolError('invalid_args', fErr);
          const content = await fsp.readFile(path.join(dir, req.query.file), 'utf8')
            .catch(() => { throw new ToolError('skill_not_found', `no file '${req.query.file}' in skill '${name}'`); });
          return ok({ name, file: req.query.file, content });
        }
        const instructions = await fsp.readFile(path.join(dir, 'SKILL.md'), 'utf8');
        return ok({ name, instructions, files: await bundledFiles(dir) });
      } catch (e) { return handle(reply, e); }
    });

  // Manage — every write, validated, through the container.
  app.post<{ Body: ManageBody }>('/skills', { schema: { ...TAG, summary: 'Create, patch, edit or delete a skill',
    headers: sessionHeader,
    body: { type: 'object', required: ['action', 'name'], properties: {
      action: { type: 'string', enum: ['create', 'edit', 'patch', 'delete', 'write_file', 'remove_file'] },
      name: { type: 'string' },
      content: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
      file_path: { type: 'string' },
      file_content: { type: 'string' },
    } } } },
  async (req, reply) => {
    try {
      const session = await requireSession(ctx, req.headers);
      const nameErr = validateSkillName(req.body.name);
      if (nameErr) throw new ToolError('invalid_args', nameErr);

      const workspaceRows = await ctx.db.select().from(workspaces).where(eq(workspaces.id, session.workspaceId));
      let container;
      try {
        container = await deps.containers.ensure(ctx.db, session, workspaceRows[0]);
      } catch (e) {
        throw new ToolError('container_start_failed', (e as Error).message, true);
      }
      const ws = new Sandbox(deps.docker, container);

      // Writes reach the REPO tier only. When the name exists solely in the
      // image's system tier, say so — "no skill" would gaslight an agent that
      // just saw it in skill_list.
      const systemHas = !(await skillExists(ctx, session.folderId ?? session.id, req.body.name))
        && (await systemSkillTree(deps.docker, await imageFor(session))).has(req.body.name);
      const data = await manage(ctx, ws, session, req.body, systemHas);
      return ok(data);
    } catch (e) { return handle(reply, e); }
  });
}

async function manage(ctx: AppCtx, ws: Sandbox, session: SessionRow, body: ManageBody,
  systemHas = false): Promise<unknown> {
  const { action, name } = body;
  const exists = await skillExists(ctx, session.folderId ?? session.id, name);
  const hostDir = skillDirHost(ctx, session.folderId ?? session.id, name);
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
      await writeViaContainer(ws, name, 'SKILL.md', body.content);
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
      await writeViaContainer(ws, name, rel, r.content);
      return { message: `Patched ${rel} in '${name}' (${r.count} replacement${r.count === 1 ? '' : 's'}, ${r.strategy}).` };
    }

    case 'delete': {
      if (!exists) throw notFound();
      const r = await ws.run(['rm', '-rf', skillDirContainer(name)]);
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
      await writeViaContainer(ws, name, body.file_path!, body.file_content);
      return { message: `Wrote ${body.file_path} to skill '${name}'.` };
    }

    case 'remove_file': {
      if (!exists) throw notFound();
      const fErr = validateFilePath(body.file_path ?? '');
      if (fErr) throw new ToolError('invalid_args', fErr);
      const present = await fsp.access(path.join(hostDir, body.file_path!)).then(() => true, () => false);
      if (!present) throw new ToolError('skill_not_found', `no file '${body.file_path}' in skill '${name}'`);
      const r = await ws.run(['rm', '-f', `${skillDirContainer(name)}/${body.file_path}`]);
      if (r.exitCode !== 0) throw new ToolError('invalid_args', `remove failed: ${r.stderr.toString('utf8').slice(0, 200)}`);
      return { message: `Removed ${body.file_path} from skill '${name}'.` };
    }

    default:
      throw new ToolError('invalid_args', `unknown action '${String(action)}'`);
  }
}
