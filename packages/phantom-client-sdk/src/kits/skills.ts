// The SKILLS kit — skill_list, skill_load, skill_manage, over the /skills
// routes (the repo's .agents/skills/ and the image's system skills, merged
// server-side; repo wins a name collision). skill_load repeats cheaply: an
// unchanged skill served twice in one build's life returns a one-line stub.
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { callRaw } from '../backend.js';
import type { ToolKit, ToolKitContext } from '../toolkit.js';

const DEDUP_STUB = 'Skill content unchanged since it was loaded earlier in this conversation — ' +
  'refer to the earlier skill_load result; it is still current and complete.';

export const skillsToolKit: ToolKit = {
  name: 'skills',
  mutatingToolNames: ['skill_manage'],
  version: (ctx) => `${ctx.sessionId}:${ctx.folderId ?? ''}`,
  build(ctx: ToolKitContext): Promise<Record<string, Tool>> {
    const served = new Map<string, string>();
    const api = <T>(method: string, p: string, body?: unknown) =>
      callRaw<T>(ctx.backend, method, p, body, { sessionId: ctx.sessionId });
    return Promise.resolve({
      skill_list: tool({
        description: "The live skill set, full descriptions. Use when the clipped index in your " +
          "instructions isn't enough to decide, or a skill might exist the index doesn't show " +
          '(created mid-session). Repo skills (.agents/skills/) shadow system ones (baked into ' +
          'this machine) on a collision.',
        inputSchema: z.object({}),
        execute: async () => {
          const r = await api<{ skills: unknown }>('GET', '/skills');
          return r.ok ? { skills: r.data?.skills } : r;
        },
      }),
      skill_load: tool({
        description: "Load a skill's full instructions — BEFORE planning any task it matches, then " +
          'follow them exactly. Loading is cheap; err on the side of loading. Returns the whole ' +
          "SKILL.md plus the skill's bundled file names in one call; call again with `file` only " +
          'when the instructions point at one.',
        inputSchema: z.object({
          name: z.string().describe('the skill name, from the index in your instructions or skill_list'),
          file: z.string().optional().describe("a bundled file to read instead (e.g. 'references/api.md')"),
        }),
        execute: async ({ name, file }) => {
          const r = await api<Record<string, unknown>>('GET',
            `/skills/${encodeURIComponent(name)}${file ? `?file=${encodeURIComponent(file)}` : ''}`);
          if (!r.ok || !r.data) return r;
          const key = `${name}${file ?? ''}`;
          const content = JSON.stringify(r.data.instructions ?? r.data.content ?? '');
          if (served.get(key) === content) return { name, note: DEDUP_STUB };
          served.set(key, content);
          return r.data;
        },
      }),
      skill_manage: tool({
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
          'reaches NEW sessions\' prompts; this session sees it via skill_list.',
        inputSchema: z.object({
          action: z.enum(['create', 'edit', 'patch', 'delete', 'write_file', 'remove_file']),
          name: z.string().describe("skill name (lowercase, hyphens; IS the folder name, e.g. 'pdf-tools')"),
          content: z.string().optional().describe('full SKILL.md (frontmatter + body) — required for create/edit'),
          old_string: z.string().optional().describe('patch: text to find; include enough context to be unique'),
          new_string: z.string().optional().describe('patch: replacement (empty string deletes the match); must differ from old_string'),
          replace_all: z.boolean().optional().describe('patch: replace every occurrence instead of requiring a unique match'),
          file_path: z.string().optional().describe('bundled-file path under references/templates/scripts/assets — required for write_file/remove_file; patch defaults to SKILL.md'),
          file_content: z.string().optional().describe('the file content, for write_file'),
        }),
        execute: (args) => api('POST', '/skills', args),
      }),
    });
  },
};
