/**
 * The GIT kit — auto-push and auto-pull, headless. Needs: a phantom-backend
 * and a session. Thin clients on `POST /git/auto-push` and `POST /git/auto-pull`
 * (each an ND-JSON stream: step records, then one result), the same pattern
 * as the web and kanban kits.
 *
 * Two things live here:
 * - `autoPushSession` — the ONE client of the push route. The cli's `/auto-push`
 *   and Assistant handler, the Telegram `/auto_push` command and the Telegram
 *   Assistant all push through it.
 * - `autoPullSession` — the ONE client of the pull route. The Telegram
 *   `/auto_pull` command, the Telegram Assistant and the cli's Assistant
 *   handler all pull through it, so each stream is read in exactly one place.
 *
 * The CODING agent has NO git tool, push or pull: moving code between a
 * session's branch and the base branch is a person's call, made through the
 * slash commands (`/auto-push`, Telegram's `/auto_push` and `/auto_pull`) or
 * the Assistant. The Assistant's `git_auto_push` / `git_auto_pull` (session on
 * screen, or an id) are in tui.ts: same host-handler shape as the rest of
 * that kit.
 */
import { ndjson } from '../../ndjson.js';

const SESSION_HEADER = 'x-phantom-looper-session';

export interface GitToolsConfig {
  baseUrl: string;
  apiKey: string;
  sessionId: string;
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
  lock: 'taking the session',
  backup: 'backing the branch up',
  commit: 'committing',
  rebase: 'replaying the work on the base branch',
  resolve: 'resolving conflicts',
  verify: 'verifying against the repo',
  push_branch: 'pushing the branch',
  push_base: 'pushing to the base branch',
  retry: 'base moved — replaying again',
};

/** The pull's step names, in words. The same steps as a push — it is the same
 *  flow — minus the landing. */
export const AUTO_PULL_STEPS: Record<string, string> = {
  lock: 'taking the session',
  backup: 'backing the branch up',
  commit: 'committing this session\'s work',
  rebase: 'replaying the work on the base branch',
  resolve: 'resolving conflicts',
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
    throw new Error(j.error?.message ?? `phantom-backend at ${cfg.baseUrl} refused ${route} with HTTP ${r.status} and no message`);
  }
  if (!r.body) throw new Error(`phantom-backend at ${cfg.baseUrl} answered ${route} with HTTP ${r.status} and no stream`);
  let result: T | undefined;
  for await (const rec of ndjson(r.body)) {
    if (rec.event === 'step' && typeof rec.step === 'string') onStep?.(steps[rec.step] ?? rec.step);
    else if (rec.event === 'result') {
      const { event: _e, ...rest } = rec;
      result = { result: 'error', ...rest } as unknown as T;
    }
  }
  if (!result) throw new Error(`phantom-backend ended the ${route} stream without a result — the server log has the reason`);
  return result;
}
