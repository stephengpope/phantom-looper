// The GIT kit — git_auto_push, git_auto_pull: land a session's work on the
// base branch, or bring the base branch into it. Thin clients on
// POST /git/auto-push and /git/auto-pull (each an ND-JSON stream: step
// records, then one result). The same two functions are exported for a
// client's own slash commands, so each stream is read in exactly one place.
//
// The CODING agent does not carry this kit: moving code between branches is
// a person's call, or the assistant's on their behalf.
import { tool } from 'ai';
import { z } from 'zod';
import { headersFor, type PhantomBackend } from '../backend.js';
import { PhantomError } from '../errors.js';
import type { BuiltTools, ToolKit, ToolKitContext } from '../toolkit.js';

/** `result` is one of the named outcomes today; anything the server adds
 *  later arrives as a string the client shows raw. */
export interface AutoPushOutcome {
  result: string;   // 'pushed' | 'nothing' | 'blocked' | 'error' | 'busy'
  reason?: string; sha?: string; rounds?: number;
}
export interface AutoPullOutcome {
  result: string;   // 'merged' | 'clean' | 'blocked' | 'error' | 'busy'
  reason?: string; arrived?: string[]; files?: string[]; sha?: string; pushed?: boolean;
}

export const AUTO_PUSH_STEPS: Record<string, string> = {
  lock: 'taking the session', backup: 'backing the branch up', commit: 'committing',
  rebase: 'replaying the work on the base branch', resolve: 'Fix Conflicts',
  verify: 'verifying against the repo', push_branch: 'pushing the branch',
  push_base: 'pushing to the base branch', retry: 'base moved — replaying again',
};
export const AUTO_PULL_STEPS: Record<string, string> = {
  lock: 'taking the session', backup: 'backing the branch up', commit: 'committing this session\'s work',
  rebase: 'replaying the work on the base branch', resolve: 'Fix Conflicts',
  verify: 'verifying against the repo', push_branch: 'pushing the branch',
};

export function autoPushSession(b: PhantomBackend, sessionId: string, onStep?: (label: string) => void): Promise<AutoPushOutcome> {
  return runGitStream<AutoPushOutcome>('auto-push', AUTO_PUSH_STEPS, b, sessionId, onStep);
}
export function autoPullSession(b: PhantomBackend, sessionId: string, onStep?: (label: string) => void): Promise<AutoPullOutcome> {
  return runGitStream<AutoPullOutcome>('auto-pull', AUTO_PULL_STEPS, b, sessionId, onStep);
}

/** One JSON record per line off a streaming body. A torn last line is dropped. */
async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { yield JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    }
  }
}

async function runGitStream<T extends { result: string }>(
  route: 'auto-push' | 'auto-pull', steps: Record<string, string>,
  b: PhantomBackend, sessionId: string, onStep?: (label: string) => void,
): Promise<T> {
  const f = b.fetch ?? fetch;
  const r = await f(`${b.url}/git/${route}`, {
    method: 'POST',
    headers: headersFor(b, { sessionId, body: true }),
    body: '{}',
  });
  if ((r.headers.get('content-type') ?? '').includes('application/json')) {
    const j = await r.json() as { ok: boolean; error?: { code?: string; message?: string } };
    throw new PhantomError('backend_error', j.error?.message ?? `${route} refused with HTTP ${r.status}`);
  }
  if (!r.body) throw new PhantomError('backend_error', `${route} answered HTTP ${r.status} with no stream`);
  let result: T | undefined;
  for await (const rec of ndjson(r.body)) {
    if (rec.event === 'step' && typeof rec.step === 'string') {
      const detail = typeof rec.detail === 'string' && rec.detail ? ` — ${rec.detail}` : '';
      onStep?.(`${steps[rec.step] ?? rec.step}${detail}`);
    } else if (rec.event === 'result') {
      const { event: _e, ...rest } = rec;
      result = { result: 'error', ...rest } as unknown as T;
    }
  }
  if (!result) throw new PhantomError('backend_error', `the ${route} stream ended without a result — the server log has the reason`);
  return result;
}

export interface GitToolKitOptions {
  /** The session the tools act on when the model names none. */
  targetSession: () => string | null;
  /** Each step in words, as it happens. */
  onStep?: (sessionId: string, label: string) => void;
}

export function gitToolKit(o: GitToolKitOptions): ToolKit {
  return {
    name: 'git',
    version: () => 'git',
    build(ctx: ToolKitContext): Promise<BuiltTools> {
      const target = (args: { id?: string }) => args.id ?? o.targetSession();
      const steps = (id: string) => (label: string) => o.onStep?.(id, label);
      return Promise.resolve({ mutating: ['git_auto_push', 'git_auto_pull'], tools: {
        git_auto_push: tool({
          description: 'Land a session\'s work on the base branch: commit, replay on base, verify, push. ' +
            'The session on screen unless an id is given. Reports how it went.',
          inputSchema: z.object({ id: z.string().optional().describe('a session id from session_list') }),
          execute: async (args) => {
            const id = target(args);
            if (!id) return { error: 'no session is open — nothing to push' };
            try { return { session: id, ...await autoPushSession(ctx.backend, id, steps(id)) }; }
            catch (e) { return { session: id, result: 'error', reason: (e as Error).message }; }
          },
        }),
        git_auto_pull: tool({
          description: 'Bring the base branch into a session: commit its work, replay on base, verify, push the branch. ' +
            'The session on screen unless an id is given. Reports how it went.',
          inputSchema: z.object({ id: z.string().optional().describe('a session id from session_list') }),
          execute: async (args) => {
            const id = target(args);
            if (!id) return { error: 'no session is open — nothing to pull into' };
            try { return { session: id, ...await autoPullSession(ctx.backend, id, steps(id)) }; }
            catch (e) { return { session: id, result: 'error', reason: (e as Error).message }; }
          },
        }),
      } });
    },
  };
}
