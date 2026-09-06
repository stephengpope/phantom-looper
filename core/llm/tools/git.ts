/**
 * The GIT kit — auto-push and auto-pull, headless. Needs: a phantom-backend
 * and a session. Thin clients on `POST /git/auto-push` and `POST /git/auto-pull`
 * (each an ND-JSON stream: step records, then one result), the same pattern
 * as the web and kanban kits.
 *
 * Three things live here:
 * - `autoPushSession` — the ONE client of the push route. The cli's `/auto-push`
 *   and Assistant handler, the Telegram `/auto_push` command and the Telegram
 *   Assistant all push through it.
 * - `autoPullSession` — the ONE client of the pull route. The coding kit, the
 *   Telegram `/auto_pull` command, the Telegram Assistant and the cli's Assistant
 *   handler all pull through it, so each stream is read in exactly one place.
 * - `codingGitTools` — `git_auto_pull` for the CODING agent, bound to its own
 *   session at build (no session input: an agent pulls into its own branch
 *   and nowhere else). Declared mutating — plan mode drops it, because a pull
 *   commits and merges. The coding agent has NO push tool: landing on base is
 *   a person's call.
 *
 * The Assistant's `git_auto_push` / `git_auto_pull` (session on screen, or an
 * id) are in tui.ts: same host-handler shape as the rest of that kit.
 */
import { tool, type Tool } from 'ai';
import { z } from 'zod';
import { ndjson } from '../../ndjson.js';
import { pickKit, type KitPick } from './presets.js';

const SESSION_HEADER = 'x-phantom-looper-session';

export interface GitToolsConfig {
  baseUrl: string;
  apiKey: string;
  sessionId: string;
  pick?: KitPick;
  fetch?: typeof fetch;
  /** The lock identity header, when the caller has one (the cli). */
  clientId?: string;
}

/** What `/git/auto-push` answers with — see phantom-backend/git/autoPush.ts. */
export interface AutoPushOutcome {
  result: 'pushed' | 'nothing' | 'blocked' | 'error' | 'busy' | string;
  reason?: string;
  /** The commit that landed on base (pushed only). */
  sha?: string;
  rounds?: number;
}

/** What `/git/auto-pull` answers with — see phantom-backend/git/autoPull.ts. */
export interface AutoPullOutcome {
  result: 'merged' | 'clean' | 'blocked' | 'error' | 'busy' | string;
  reason?: string;
  arrived?: string[];
  files?: string[];
  sha?: string;
  pushed?: boolean;
}

/** The push's step names, in words — for a client that shows progress. Anything
 *  the server adds later shows raw. */
export const AUTO_PUSH_STEPS: Record<string, string> = {
  commit: 'committing',
  merge: 'merging the base branch in',
  fix: 'resolving conflicts',
  verify: 'verifying against the repo',
  push_branch: 'pushing the branch',
  push_base: 'pushing to the base branch',
  retry: 'base moved — merging again',
};

/** The pull's step names, in words. */
export const AUTO_PULL_STEPS: Record<string, string> = {
  fetch: 'fetching the base branch',
  commit: 'committing this session\'s work',
  merge: 'merging the base branch in',
  fix: 'resolving conflicts',
  verify: 'verifying against the repo',
  push_branch: 'pushing the branch',
};

/** POST /git/auto-push for one session and read its stream to the end. A
 *  refusal (unknown session, route unwired) is the plain JSON envelope, sent
 *  before any stream — it throws with the server's message. Every step reaches
 *  `onStep` in words as it arrives; the one result record is the answer. */
export function autoPushSession(cfg: GitToolsConfig, onStep?: (label: string) => void): Promise<AutoPushOutcome> {
  return runGitStream<AutoPushOutcome>('auto-push', AUTO_PUSH_STEPS, cfg, onStep);
}

/** POST /git/auto-pull for one session — the same wire, the other direction. */
export function autoPullSession(cfg: GitToolsConfig, onStep?: (label: string) => void): Promise<AutoPullOutcome> {
  return runGitStream<AutoPullOutcome>('auto-pull', AUTO_PULL_STEPS, cfg, onStep);
}

/** The one reader of both git streams: `step` records → `onStep` in words,
 *  the single `result` record → the answer; heartbeats fall through. */
async function runGitStream<T extends { result: string }>(
  route: 'auto-push' | 'auto-pull', steps: Record<string, string>,
  cfg: GitToolsConfig, onStep?: (label: string) => void,
): Promise<T> {
  const f = cfg.fetch ?? fetch;
  const r = await f(`${cfg.baseUrl}/git/${route}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json',
      [SESSION_HEADER]: cfg.sessionId,
      ...(cfg.clientId ? { 'x-phantom-looper-client': cfg.clientId } : {}),
    },
    body: '{}',
  });
  if ((r.headers.get('content-type') ?? '').includes('application/json')) {
    const j = await r.json() as { ok: boolean; error?: { code?: string; message?: string } };
    throw new Error(j.error?.message ?? j.error?.code ?? `${route}: HTTP ${r.status}`);
  }
  if (!r.body) throw new Error(`${route}: HTTP ${r.status}`);
  let result: T | undefined;
  for await (const rec of ndjson(r.body)) {
    if (rec.event === 'step' && typeof rec.step === 'string') onStep?.(steps[rec.step] ?? rec.step);
    else if (rec.event === 'result') {
      const { event: _e, ...rest } = rec;
      result = { result: 'error', ...rest } as unknown as T;
    }
  }
  if (!result) throw new Error(`${route}: the stream ended without a result`);
  return result;
}

const MUTATING = ['git_auto_pull'] as const;

export function codingGitTools(cfg: GitToolsConfig): Record<string, Tool> {
  return pickKit(buildCodingGitTools(cfg), MUTATING, cfg.pick);
}

function buildCodingGitTools(cfg: GitToolsConfig): Record<string, Tool> {
  return {
    git_auto_pull: tool({
      description: 'Bring the base branch into THIS session\'s branch: fetch origin, merge the base branch in, ' +
        'and let the Git Fixer resolve any conflict. Use it before you start on an area others may have ' +
        'touched, when a file looks different from what you last wrote, and before you report a task done — ' +
        'so the eventual auto-push has nothing left to fight. It commits your in-flight work first (the branch ' +
        'is append-only; auto-push would make that commit anyway), then pushes the branch as a backup. Nothing ' +
        'reaches the base branch. Runs to the end before answering — a conflict can take minutes. The answer is ' +
        'one of: merged (with `arrived`, the base commits that came in, and `files`, what changed under you — ' +
        're-read those before editing them), clean (nothing to pull), blocked (a conflict the fixer could not ' +
        'resolve; the branch is exactly as it was), or error. Prefer this over your own git fetch/merge: it ' +
        'runs with the repository\'s credentials and the fixer, your shell usually has neither.',
      inputSchema: z.object({}),
      execute: async () => {
        try { return await autoPullSession(cfg); }
        catch (e) { return { result: 'error', reason: (e as Error).message }; }
      },
    }),
  };
}
