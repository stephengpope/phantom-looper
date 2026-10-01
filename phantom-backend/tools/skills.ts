// The SKILL tools — skill_list, skill_load, skill_manage, over skills.ts (the
// repo's .agents/skills/ and the image's system skills, merged; repo wins a
// name collision). Offered only to a session with files: a skill lives in a
// repo.
import { listSkills, loadSkill, manageSkill, type ManageBody } from '../skills.js';
import { ToolError } from './envelope.js';
import { obj, oneOf, str, type OfferCtx, type ToolCtx, type ToolDef } from './def.js';

const hasRepo = ({ app, session }: OfferCtx) => Promise.resolve(!!app.fs && !!session.workspaceId);

/** The container wiring, or the refusal the model can act on. */
function deps(ctx: ToolCtx) {
  if (!ctx.app.fs) throw new ToolError('container_unavailable', 'containers are not wired on this server', false);
  if (!ctx.session.workspaceId) throw new ToolError('no_workspace', 'this session has no files — no skills to read');
  return { fs: ctx.app.fs, workspaceId: ctx.session.workspaceId };
}

export const SKILL_TOOLS: ToolDef[] = [
  {
    name: 'skill_list',
    summary: 'The live skill set.',
    description: "The live skill set, full descriptions. Use when the clipped index in your " +
      "instructions isn't enough to decide, or a skill might exist the index doesn't show " +
      '(created mid-session). Repo skills (.agents/skills/) shadow system ones (baked into ' +
      'this machine) on a collision.',
    input: obj({}),
    mutates: false, agents: ['coding'], offered: hasRepo,
    execute(ctx) {
      const d = deps(ctx);
      return listSkills(ctx.app, d.fs, ctx.session, d.workspaceId);
    },
  },
  {
    name: 'skill_load',
    summary: "Load a skill's full instructions.",
    description: "Load a skill's full instructions — BEFORE planning any task it matches, then " +
      'follow them exactly. Loading is cheap; err on the side of loading. Returns the whole ' +
      "SKILL.md plus the skill's bundled file names in one call; call again with `file` only " +
      'when the instructions point at one.',
    input: obj({
      name: str('the skill name, from the index in your instructions or skill_list'),
      file: str("a bundled file to read instead (e.g. 'references/api.md')"),
    }, ['name']),
    mutates: false, agents: ['coding'], offered: hasRepo,
    execute(ctx, a) {
      const d = deps(ctx);
      return loadSkill(ctx.app, d.fs, ctx.session, d.workspaceId, String(a.name), a.file === undefined ? undefined : String(a.file));
    },
  },
  {
    name: 'skill_manage',
    summary: 'Create, patch, edit or delete a skill.',
    description: 'Create, patch, edit or delete a skill in .agents/skills/<name>/. Writes are ' +
      'validated here — never edit those files with write/edit directly.\n\n' +
      'Actions: create (full SKILL.md: frontmatter `name` matching the folder + `description` ' +
      'stating what it does AND when to use it, trigger in the first 57 chars; body = trigger ' +
      'conditions, numbered steps with exact commands, pitfalls, verification) · patch ' +
      '(old_string/new_string — PREFERRED for fixes) · edit (full rewrite — major overhauls ' +
      'only) · delete · write_file / remove_file (bundled files under references/, templates/, ' +
      'scripts/, assets/).\n\n' +
      'Create when a complex task succeeded, an error was overcome, a corrected approach ' +
      'worked, or the user asks you to remember a procedure — confirm with the user first; ' +
      'skip one-offs. Patch a skill the moment you find it wrong or missing a step — do not ' +
      'wait to be asked. System skills (baked into this machine) are read-only here — create a ' +
      'repo skill of the same name to shadow one. A new skill ' +
      "reaches NEW sessions' prompts; this session sees it via skill_list.",
    input: obj({
      action: oneOf(['create', 'edit', 'patch', 'delete', 'write_file', 'remove_file'], 'what to do'),
      name: str("skill name (lowercase, hyphens; IS the folder name, e.g. 'pdf-tools')"),
      content: str('full SKILL.md (frontmatter + body) — required for create/edit'),
      old_string: str('patch: text to find; include enough context to be unique'),
      new_string: str('patch: replacement (empty string deletes the match); must differ from old_string'),
      replace_all: { type: 'boolean', description: 'patch: replace every occurrence instead of requiring a unique match' },
      file_path: str('bundled-file path under references/templates/scripts/assets — required for write_file/remove_file; patch defaults to SKILL.md'),
      file_content: str('the file content, for write_file'),
    }, ['action', 'name']),
    mutates: true, agents: ['coding'], offered: hasRepo,
    execute(ctx, a) {
      const d = deps(ctx);
      return manageSkill(ctx.app, d.fs, ctx.session, d.workspaceId, a as unknown as ManageBody);
    },
  },
];
