// The tool surface: seven tools, mirroring the pi coding agent's default CLI
// set (bash, read, write, edit, ls, find, grep) — which knack's sandbox tools
// match one for one. Bash does everything else; mapping individual unix
// commands as tools was over-engineering and is gone.
//
// Reads are numbered; edits are NOT (the documented cross-harness failure is
// models pasting the numbered prefix into old_string). Read tools share the
// truncation envelope. Descriptions are part of the surface: they steer the
// model toward the structured tool over raw shell where structure wins.
import { Sandbox } from '../workspace/sandbox.js';
import { fuzzyFindAndReplace, formatNoMatchHint } from './fuzzy.js';
import { unifiedDiff } from './diff.js';
import { ToolError, looksBinary, type Truncation } from './envelope.js';

export interface ToolCtx {
  ws: Sandbox;
  sessionId: string;
  limits: { maxReadBytes: number; maxSearchResults: number };
  /** Injected by the route layer: full bash semantics (timeout,
   *  detached commands with ND-JSON logs). The registry stays free of db and
   *  docker plumbing. */
  runBash: (args: { cmd: string; cwd?: string; detached?: boolean; timeout?: number }) => Promise<unknown>;
}

export interface ToolDef {
  name: string;
  summary: string;
  description: string;
  input: Record<string, unknown>;   // JSON Schema
  mutates: boolean;
  streaming: boolean;
  execute: (ctx: ToolCtx, args: Record<string, unknown>) => Promise<unknown>;
}

const str = (d: string) => ({ type: 'string', description: d });
const int = (d: string, def?: number) => ({ type: 'integer', description: d, ...(def !== undefined ? { default: def } : {}) });
const bool = (d: string, def = false) => ({ type: 'boolean', description: d, default: def });
const obj = (props: Record<string, unknown>, required: string[]) => ({
  type: 'object', properties: props, required, additionalProperties: false,
});

function s(v: unknown): string {
  if (typeof v !== 'string') throw new ToolError('invalid_args', 'expected a string');
  return v;
}

const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp',
};
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

async function readText(ctx: ToolCtx, p: string): Promise<string> {
  const r = await ctx.ws.readFile(p);
  if (r.exitCode !== 0) {
    if (/no such file/i.test(r.stderr)) throw new ToolError('not_found', `${p}: no such file`);
    if (/is a directory/i.test(r.stderr)) throw new ToolError('is_directory', `${p} is a directory — use ls`);
    throw new ToolError('internal', r.stderr.slice(0, 300));
  }
  if (looksBinary(r.content)) {
    throw new ToolError('binary_file', `${p} is binary (${r.content.length} bytes) — read handles text only`);
  }
  return r.content.toString('utf8');
}

/** Numbered presentation. Display only — edit takes raw text, never numbers. */
function numbered(lines: string[], from: number): string {
  return lines.map((l, i) => `${String(from + i).padStart(6)}\t${l}`).join('\n');
}

function readRange(
  content: string, offset: number, limit: number, maxBytes: number,
): { text: string; truncated?: Truncation } {
  const lines = content.split('\n');
  const total = lines.length;
  const from = Math.max(1, offset);
  let to = Math.min(total, from + limit - 1);
  let slice = lines.slice(from - 1, to);
  let text = numbered(slice, from);
  let reason: Truncation['reason'] | null = to < total || from > 1 ? 'limit' : null;
  if (Buffer.byteLength(text) > maxBytes) {
    while (slice.length > 1 && Buffer.byteLength(numbered(slice, from)) > maxBytes) slice.pop();
    to = from + slice.length - 1;
    text = numbered(slice, from);
    reason = 'max_bytes';
  }
  if (reason) {
    return {
      text,
      truncated: {
        reason, shown: { from, to }, total,
        hint: to < total ? `call again with offset=${to + 1}` : 'showing a partial range',
      },
    };
  }
  return { text };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'bash',
    summary: 'Run a shell command in the workspace.',
    description: 'Runs a shell command in the session container. For routine file work prefer ' +
      'read/edit/write/grep — structured results, fewer mistakes.\n\n' +
      'Run commands plain: the result returns the log — the tail inline, plus the path to all of ' +
      'it when long (full_output: /workspace/logs/bash-<id>.out).\n\n' +
      'A command with no timeout of its own is killed after 2 minutes.\n\n' +
      'detached=true is for commands meant to keep running (dev servers, watchers): it returns ' +
      '{cmd_id, log_file} at once. The log holds output records and ends with ' +
      '{"event":"exit","code":N} when the command stops. The user sees and can kill detached ' +
      'commands on /tasks — tell them when you start one. Never use nohup or &.',
    input: obj({
      cmd: str('The command, run via /bin/sh -c.'),
      cwd: str('Working directory (default /workspace/repo).'),
      timeout: int('Milliseconds before the command is killed. Unset = the 2-minute default.'),
      detached: bool('true = background: return {cmd_id, log_file} now and keep the command running.'),
    }, ['cmd']),
    mutates: true, streaming: false,
    async execute(ctx, a) {
      return ctx.runBash({
        cmd: s(a.cmd), cwd: a.cwd ? s(a.cwd) : undefined, detached: Boolean(a.detached),
        timeout: a.timeout === undefined ? undefined : Number(a.timeout),
      });
    },
  },
  {
    name: 'read',
    summary: 'Read a file: text with 1-indexed line numbers, or an image.',
    description: 'Text returns numbered lines; use offset/limit for large files and continue ' +
      'with offset until complete — the truncation envelope says exactly where to resume. The ' +
      'numbers are display only — never include them in edit old_string. Images (png, jpg, gif, ' +
      'webp, bmp) are returned as the image itself. Other binary files are refused with their size.',
    input: obj({
      path: str('File to read, repo-relative or absolute.'),
      offset: int('1-indexed first line (default 1).', 1),
      limit: int('Max lines (default 2000).', 2000),
    }, ['path']),
    mutates: false, streaming: false,
    async execute(ctx, a) {
      const p = s(a.path);
      const ext = p.slice(p.lastIndexOf('.') + 1).toLowerCase();
      if (IMAGE_TYPES[ext]) {
        const r = await ctx.ws.readFile(p);
        if (r.exitCode !== 0) throw new ToolError('not_found', `${p}: no such file`);
        if (r.content.length > MAX_IMAGE_BYTES) {
          throw new ToolError('too_large', `${p} is ${r.content.length} bytes — image limit is ${MAX_IMAGE_BYTES}`);
        }
        return { image: { media_type: IMAGE_TYPES[ext], base64: r.content.toString('base64'), bytes: r.content.length } };
      }
      const content = await readText(ctx, p);
      const { text, truncated } = readRange(content, Number(a.offset ?? 1), Number(a.limit ?? 2000), ctx.limits.maxReadBytes);
      return truncated ? { content: text, truncated } : { content: text };
    },
  },
  {
    name: 'write',
    summary: 'Write a file, replacing any existing content.',
    description: 'Creates parent directories. Overwrites the whole file — for targeted changes to ' +
      'an existing file use edit instead, which is safer and cheaper than rewriting.',
    input: obj({ path: str('File to write.'), content: str('Complete file content.') }, ['path', 'content']),
    mutates: true, streaming: false,
    async execute(ctx, a) {
      const p = s(a.path);
      await ctx.ws.writeFile(p, Buffer.from(s(a.content), 'utf8'));
      return { path: Sandbox.resolvePath(p), bytes: Buffer.byteLength(s(a.content)) };
    },
  },
  {
    name: 'edit',
    summary: 'Targeted find-and-replace in an existing file.',
    description: 'The preferred way to change a file. old_string must be UNIQUE (include ' +
      'surrounding lines) unless replace_all. Exact match first, then whitespace/indentation-' +
      'tolerant fallbacks; the response names the strategy used and returns a unified diff of ' +
      'what actually changed, verified by re-reading the file. Empty new_string deletes the match. ' +
      'Never include read line numbers in old_string.',
    input: obj({
      path: str('File to edit.'),
      old_string: str('Exact text to find (unique unless replace_all). Use edits[] instead for several changes at once.'),
      new_string: str('Replacement. Empty deletes the matched text.'),
      replace_all: bool('Replace every occurrence.'),
      edits: {
        type: 'array',
        description: 'Several replacements applied together, in order, all-or-nothing: if any old_string fails to match uniquely, the file is untouched.',
        items: obj({
          old_string: str('Exact text to find (unique in the file).'),
          new_string: str('Replacement. Empty deletes.'),
          replace_all: bool('Replace every occurrence of this one.'),
        }, ['old_string', 'new_string']),
      },
    }, ['path']),
    mutates: true, streaming: false,
    async execute(ctx, a) {
      const p = s(a.path);
      const before = await readText(ctx, p).catch((e: ToolError) => {
        if (e.code === 'not_found') throw new ToolError('not_found', `${p} does not exist — use write to create it`);
        throw e;
      });
      const list = Array.isArray(a.edits) && a.edits.length
        ? (a.edits as { old_string: unknown; new_string: unknown; replace_all?: unknown }[])
        : [{ old_string: a.old_string, new_string: a.new_string, replace_all: a.replace_all }];
      if (list.length === 1 && (list[0].old_string === undefined || list[0].new_string === undefined)) {
        throw new ToolError('invalid_args', 'provide old_string/new_string, or edits[]');
      }
      // All-or-nothing: every edit applies to the accumulating content, and one
      // failure leaves the file untouched.
      let content = before;
      const applied: { strategy: string | null; replacements: number }[] = [];
      for (let i = 0; i < list.length; i++) {
        const e = list[i];
        const res = fuzzyFindAndReplace(content, s(e.old_string), s(e.new_string), Boolean(e.replace_all));
        if (res.error) {
          const code = res.error.startsWith('Found ') ? 'not_unique' : 'no_match';
          const at = list.length > 1 ? `edits[${i}]: ` : '';
          throw new ToolError(code, at + res.error + formatNoMatchHint(res.error, res.count, s(e.old_string), content));
        }
        content = res.content;
        applied.push({ strategy: res.strategy, replacements: res.count });
      }
      await ctx.ws.writeFile(p, Buffer.from(content, 'utf8'));
      const after = await readText(ctx, p);
      if (after !== content) {
        throw new ToolError('internal', 'post-write verification failed — re-read and retry', true);
      }
      return list.length > 1
        ? { edits: applied, diff: unifiedDiff(p, before, content) }
        : { replacements: applied[0].replacements, strategy: applied[0].strategy, diff: unifiedDiff(p, before, content) };
    },
  },
  {
    name: 'ls',
    summary: 'List a directory.',
    description: 'Entries end with / when they are directories; dotfiles included; sorted. Defaults to the repo root; capped at limit (default 500).',
    input: obj({
      path: { ...str('Directory, repo-relative or absolute.'), default: '.' },
      limit: int('Max entries to return (default 500).', 500),
    }, []),
    mutates: false, streaming: false,
    async execute(ctx, a) {
      const p = Sandbox.resolvePath(s(a.path ?? '.'));
      const r = await ctx.ws.run(['ls', '-1Ap', p]);
      if (r.exitCode !== 0) {
        const e = r.stderr.toString('utf8');
        if (/no such file/i.test(e)) throw new ToolError('not_found', `${p}: no such directory`);
        if (/not a directory/i.test(e)) throw new ToolError('not_a_directory', `${p} is a file — use read`);
        throw new ToolError('internal', e.slice(0, 300));
      }
      const all = r.stdout.toString('utf8').split('\n').filter(Boolean);
      const lim = Math.max(1, Number(a.limit ?? 500));
      const entries = all.slice(0, lim);
      const out: Record<string, unknown> = { path: p, entries };
      if (all.length > entries.length) {
        out.truncated = { reason: 'limit', shown: { from: 1, to: entries.length }, total: all.length,
          hint: 'raise limit or list a subdirectory' } satisfies Truncation;
      }
      return out;
    },
  },
  {
    name: 'find',
    summary: 'Find files by glob pattern.',
    description: 'e.g. **/*.ts or src/**/config*. Respects .gitignore unless include_ignored. ' +
      'Results are capped; narrow the pattern when truncated.',
    input: obj({
      pattern: str('Glob pattern.'),
      path: { ...str('Directory to search under (default repo root).'), default: '.' },
      include_ignored: bool('Include .gitignore-d files.'),
      limit: int('Max results (default: the max_search_results setting).'),
    }, ['pattern']),
    mutates: false, streaming: false,
    async execute(ctx, a) {
      const dir = Sandbox.resolvePath(s(a.path ?? '.'));
      const argv = ['rg', '--files', ...(a.include_ignored ? ['--no-ignore'] : []), '-g', s(a.pattern), dir];
      const r = await ctx.ws.run(argv);
      if (r.exitCode === 127) throw new ToolError('internal', 'ripgrep missing from workspace image — it is a required tool');
      const all = r.stdout.toString('utf8').split('\n').filter(Boolean);
      const files = all.slice(0, Math.max(1, Number(a.limit ?? ctx.limits.maxSearchResults)));
      const out: Record<string, unknown> = { files };
      if (all.length > files.length) {
        out.truncated = { reason: 'limit', shown: { from: 1, to: files.length }, total: all.length,
          hint: 'narrow the pattern' } satisfies Truncation;
      }
      return out;
    },
  },
  {
    name: 'grep',
    summary: 'Search file contents by regex.',
    description: 'Returns {file, line, content} matches (context rows flagged context:true when ' +
      'context > 0), capped at limit — the result carries the true total. Long lines truncated to ' +
      '500 chars. Respects .gitignore. Restrict scope with path and glob when a pattern is common.',
    input: obj({
      pattern: str('Regex to search for (or a literal string with literal=true).'),
      path: { ...str('Directory or file to search (default repo root).'), default: '.' },
      ignore_case: bool('Case-insensitive.'),
      literal: bool('Treat pattern as a literal string, not a regex.'),
      context: int('Lines of context before and after each match (default 0).', 0),
      limit: int('Max matches (default: the max_search_results setting).'),
      glob: str('Restrict to files matching this glob (optional).'),
    }, ['pattern']),
    mutates: false, streaming: false,
    async execute(ctx, a) {
      const dir = Sandbox.resolvePath(s(a.path ?? '.'));
      const ctxLines = Math.max(0, Number(a.context ?? 0));
      const argv = ['rg', '--json', ...(a.ignore_case ? ['-i'] : []),
        ...(a.literal ? ['-F'] : []), ...(ctxLines ? ['-C', String(ctxLines)] : []),
        ...(a.glob ? ['-g', s(a.glob)] : []), '-e', s(a.pattern), dir];
      const r = await ctx.ws.run(argv, { maxBytes: 8 * 1024 * 1024 });
      if (r.exitCode === 127) throw new ToolError('internal', 'ripgrep missing from workspace image — it is a required tool');
      if (r.exitCode === 2) throw new ToolError('invalid_args', r.stderr.toString('utf8').slice(0, 300));
      const cap = Math.max(1, Number(a.limit ?? ctx.limits.maxSearchResults));
      const matches: { file: string; line: number; content: string; context?: true }[] = [];
      let total = 0;
      for (const lineText of r.stdout.toString('utf8').split('\n')) {
        if (!lineText) continue;
        let j: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
        try { j = JSON.parse(lineText); } catch { continue; }
        if (j.type !== 'match' && j.type !== 'context') continue;
        const row = {
          file: j.data?.path?.text ?? '',
          line: j.data?.line_number ?? 0,
          content: (j.data?.lines?.text ?? '').replace(/\n$/, '').slice(0, 500),
          ...(j.type === 'context' ? { context: true as const } : {}),
        };
        if (j.type === 'match') { total++; if (total <= cap) matches.push(row); }
        else if (total <= cap && ctxLines) matches.push(row);
      }
      const out: Record<string, unknown> = { matches };
      if (total > cap) {
        out.truncated = { reason: 'limit', shown: { from: 1, to: cap }, total,
          hint: 'narrow the pattern, add a glob, or raise limit' } satisfies Truncation;
      }
      return out;
    },
  },
];

export const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
