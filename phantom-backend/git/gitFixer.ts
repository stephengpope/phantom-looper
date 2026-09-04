// The Git Fixer — the conflict resolver for auto-push and manual pulls. When a
// merge leaves markers, this model-driven
// loop resolves them. The model is provider-agnostic (AI SDK core, provider
// packages only — no gateway) and chosen at runtime from settings
// (auto_push_fix_provider / auto_push_fix_model / auto_push_fix_base_url) plus the API key for whichever provider that names. Design constraints, each verified or battle-tested:
//
// - HOLDS NO CREDENTIALS. It resolves and commits; the caller pushes. Its
//   shell runs INSIDE the workspace container — the model is driving commands
//   over conflicting content, the least-trusted input in the system, so it
//   lives in the most-contained place.
// - INDEPENDENTLY VERIFIED. Never trust what the model said it did — re-read
//   the repo. Unmerged entries via `git diff --diff-filter=U`; NEVER a grep
//   for ======= (matches Setext markdown headings, verified — the
//   bug is live in Shockwave's fixer today).
// - BOUNDED BY ATTEMPTS and the agent's own maxSteps, never wall-clock: a
//   auto-push has no time limit, and a clock that severed a legitimate long
//   resolution mid-file was worse than none.
// - RETRIED ON THE SAME DIRECTORY: attempt 2 opens a repo where attempt 1's
//   resolutions are already in place and carries on.
import path from 'node:path';
import { isProvider } from '../../core/llm/createAgent.js';
import { gitFixerAgent, gitFixerInstructions, toGitFixer } from '../../core/llm/agents/gitFixer.js';
import { Transcript } from '../../core/llm/transcript.js';
import { git } from './git.js';
import { logger, errStr } from '../log.js';

const log = logger('gitFixer');

/** The one capability a driver gets: run a shell command in the conflicted
 *  repo. Production backs it with the workspace container; tests script it. */
export type GitFixerExec = (cmd: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface GitFixerDriver {
  available(): Promise<boolean>;
  /** `transcriptPath`: where to write this run's conversation (the shared
   *  JSONL transcript format). Optional — scripted test drivers ignore it. */
  runSession(exec: GitFixerExec, branch: string, sessionId: string, transcriptPath?: string): Promise<void>;
}

/** Clean tree AND no unmerged index entries AND — when a base branch is named —
 *  the merge actually happened. Run against the directory, not against any
 *  claim the driver made.
 *
 *  The last check is not decoration. `git merge --abort` leaves a clean tree
 *  with no unmerged entries, so the first two conditions call a give-up a
 *  success: the caller then logs "resolved", pushes, and the same conflict
 *  returns on the next interval forever. Requiring origin/<base> to be an
 *  ancestor of HEAD is the only statement of "the merge is in". */
export async function verifyResolved(dir: string, baseBranch?: string): Promise<boolean> {
  try {
    const { stdout: status } = await git(dir, ['status', '--porcelain']);
    if (status.trim()) return false;
    const { stdout: unmerged } = await git(dir, ['diff', '--name-only', '--diff-filter=U']);
    if (unmerged.trim()) return false;
    if (!baseBranch) return true;
    await git(dir, ['merge-base', '--is-ancestor', `origin/${baseBranch}`, 'HEAD']);
    return true;
  } catch { return false; }
}

export async function runGitFixer(
  dir: string, exec: GitFixerExec, branch: string, driver: GitFixerDriver,
  limits: { attempts: number }, sessionId = branch.split('/').pop() ?? branch,
  baseBranch?: string,
): Promise<boolean> {
  if (!(await driver.available())) {
    // No model is no attempt at all — the loudest silent failure this loop can
    // have is a missing key surfacing only as 'conflict' at the caller.
    log.error({ dir }, 'git fixer driver unavailable (no API credentials) — skipping');
    return false;
  }
  for (let attempt = 1; attempt <= Math.max(1, limits.attempts); attempt++) {
    log.info({ dir, branch, attempt }, 'git fixer attempt');
    // One transcript per attempt (each attempt is its own conversation),
    // beside the session's other logs — outside repo/, so a push's
    // `add -A` never commits it.
    const transcriptPath = path.join(dir, '..', 'logs', `git-fixer-${Date.now()}-a${attempt}.jsonl`);
    try { await driver.runSession(exec, branch, sessionId, transcriptPath); }
    catch (e) { log.warn({ dir, err: errStr(e) }, 'git fixer session errored'); }
    if (await verifyResolved(dir, baseBranch)) { log.info({ dir, attempt }, 'git fixer verified clean'); return true; }
  }
  return false;
}

/** Everything the driver needs, resolved at the point of use from settings +
 *  secrets so a provider/model/key change needs no restart. */
export interface GitFixerConfig {
  provider: string;          // anthropic | openai | google | openai-compatible
  model: string;
  baseUrl?: string | null;
  apiKey?: string;           // the key for auto_push_fix_provider; env is the SDK fallback
}

/** Provider-agnostic driver over the AI SDK agent from core/llm (no gateway —
 *  provider packages only). The agent runs the tool loop itself; maxSteps
 *  bounds steps and the abort signal bounds wall-clock. */
export class AiSdkGitFixerDriver implements GitFixerDriver {
  constructor(private config: () => Promise<GitFixerConfig>) {}

  async available(): Promise<boolean> {
    const c = await this.config();
    if (c.apiKey) return true;
    const envKey = { anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', google: 'GOOGLE_GENERATIVE_AI_API_KEY' }[c.provider];
    if (c.provider === 'openai-compatible') return Boolean(c.baseUrl); // local endpoints often need no key
    return Boolean(envKey && process.env[envKey]);
  }

  async runSession(exec: GitFixerExec, branch: string, sessionId: string, transcriptPath?: string): Promise<void> {
    const c = await this.config();
    if (!isProvider(c.provider)) throw new Error(`unknown auto_push_fix_provider "${c.provider}"`);
    // The Git Fixer agent — prompt stack and its `bash` tool — is
    // declared in core/llm/agents/gitFixer.ts; the model assembly (provider
    // switch, subscription-token auth, thinking rule) in core/llm/createAgent.
    const agent = gitFixerAgent(
      { provider: c.provider, model: c.model, baseUrl: c.baseUrl, apiKey: c.apiKey },
      exec, branch, sessionId,
    );
    // Every agent leaves the same record (core/llm/transcript.ts): header with
    // the frozen prompt, then each step's messages as the step lands — so a
    // run cut off by the wall-clock still shows what it did up to the cut.
    const transcript = transcriptPath
      ? new Transcript({
          type: 'session', agent: 'gitFixer', provider: c.provider, model: c.model,
          created_at: new Date().toISOString(), system_prompt: gitFixerInstructions(branch, sessionId),
          session_id: sessionId, branch,
        }, transcriptPath)
      : null;
    const prompt = toGitFixer.recover(branch);
    transcript?.append({ role: 'user', content: prompt });
    const res = await agent.stream({
      prompt,
      // createAgent's usage seam: each step's messages + usage line.
      record: transcript ?? undefined,
    });
    // Drain — the stream is lazy, and the tool loop only advances as it is read.
    for await (const _ of res.stream) { /* logged via onStepEnd */ }
  }
}
