// Deterministic git, run from the API container against the shared volume.
// Every credential-bearing call the SYSTEM makes happens here and only here, so
// no PAT is in a namespace the agent has a shell in. The one exception is
// deliberate, off by default, and lives elsewhere: `agent_git_credentials` puts
// the PAT in the workspace container's environment so the agent's own git and
// gh work (workspace/container.ts). It cannot interfere with this module — the
// guards below reset the helper list and pin remote.origin.url on every call.
//
// The guard set is ported from Shockwave (api/src/git.ts + tests/gitGuards.test.js,
// which plants real hooks and runs real pushes) with one addition their tests
// carried but their production guards had drifted from: protocol.ext.allow=never.
// Each -c below closes a vector the agent could otherwise open by writing into
// its own working copy.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger, errStr } from '../lib/log.js';
import type { Repo } from '../runtime/WorkspaceHost.js';

const exec = promisify(execFile);
const log = logger('git');

/** Answers git's credential prompt from the env var set on that one call.
 *  Passed on the command line — never a script on disk the agent could rewrite. */
const CREDENTIAL_HELPER = '!f() { echo username=x-access-token; echo password=$GITHUB_PAT; }; f';

/** NOT a directory. Git looks up `<hooksPath>/<hookname>`, and a path under the
 *  null device is ENOTDIR, so no hook is ever found — and unlike an empty
 *  directory there is nothing to keep empty. */
const NO_HOOKS = '/dev/null';

/** The client id EVERY git operation holds the session under — auto-push,
 *  auto-pull and the manual pull alike. One id, because a conflict turn opens
 *  the session from inside an operation that already holds the lock, and
 *  acquireLock only lets a holder re-take its OWN hold. The per-call `label` is
 *  what tells a person which operation is holding it. */
export const GIT_CLIENT_ID = 'phantom-git';

export interface GitAuth {
  url: string;   // plain remote URL, pinned on the command line every call
  pat?: string;  // absent for public repos; helper answers empty and https succeeds unauthenticated
}

export function guards(auth: GitAuth): string[] {
  return [
    '-c', 'credential.helper=',                                        // reset the list first
    '-c', `credential.https://github.com.helper=${CREDENTIAL_HELPER}`, // github.com ONLY — an insteadOf redirect finds no helper
    '-c', `remote.origin.url=${auth.url}`,                             // never read the repo's own remote config
    '-c', `core.hooksPath=${NO_HOOKS}`,
    '-c', 'core.fsmonitor=',
    '-c', 'core.sshCommand=',
    '-c', 'protocol.ext.allow=never',                                  // ext:: is a command, not an address
  ];
}

export function gitEnv(pat?: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GITHUB_PAT: pat ?? '',
    GIT_TERMINAL_PROMPT: '0', // never hang a background child on a TTY prompt
  };
}

/** execFile's rejection message is `Command failed: <the whole argv>` — the
 *  guard flags, the credential helper's text, everything — and that message is
 *  what error handlers up the stack end up showing people. Re-throw with
 *  git's OWN words (stderr) as the message; stdout/stderr/code ride along
 *  unchanged, so every caller that inspects `.stderr` still can. */
function cleanThrow(error: unknown): never {
  const failure = error as Error & { stderr?: string; stdout?: string; code?: unknown };
  const said = typeof failure?.stderr === 'string' ? failure.stderr.trim() : '';
  if (!said) throw error;
  const err = new Error(`git: ${said}`) as Error & { stderr?: string; stdout?: string; code?: unknown };
  err.stderr = failure.stderr; err.stdout = failure.stdout; err.code = failure.code;
  throw err;
}

/** Git in a directory of THIS process's filesystem — the raw runner. The
 *  operations below never call it with a path: they take a `Repo`, which is
 *  this on the built-in host and a job on a remote one (runtime/WorkspaceHost.ts). */
export async function git(
  cwd: string, args: string[], auth?: GitAuth,
): Promise<{ stdout: string; stderr: string }> {
  if (!auth) return exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 }).catch(cleanThrow);
  return exec('git', [...guards(auth), ...args], {
    cwd, maxBuffer: 32 * 1024 * 1024, env: gitEnv(auth.pat),
  }).catch(cleanThrow);
}

/** A checkout on this filesystem as a Repo. */
export function localRepo(dir: string): Repo {
  return {
    git: (args, auth) => git(dir, args, auth),
    exists: (rel) => fs.access(path.join(dir, rel)).then(() => true, () => false),
  };
}

/** What a git-against-GitHub failure MEANS, read off git's stderr — one
 *  classifier for every path that talks to the remote (session clones, the
 *  pool, the create-flow's seed push), so the person always gets the same
 *  words for the same problem and never a command line. Returns null for
 *  anything it does not recognise — the caller keeps its own error. Order
 *  matters: GitHub answers a bad token with "Invalid username or token" even
 *  on a repo that exists, and a good token without access with "Repository
 *  not found", so auth is checked first. */
export type GitFailureCode =
  'credential_invalid' | 'credential_insufficient' | 'repo_not_found' | 'upstream_unreachable';

export function classifyGitFailure(error: unknown, opts: { hadToken?: boolean } = {}):
  { code: GitFailureCode; message: string; retryable: boolean } | null {
  const said = String((error as { stderr?: string })?.stderr ?? (error as Error)?.message ?? error);
  if (/invalid username or token|authentication failed|401/i.test(said)) {
    return { code: 'credential_invalid', retryable: false,
      message: opts.hadToken === false
        ? 'the repository needs authentication and no github_token is stored — save one (phantom-cli: /keys)'
        : 'GitHub rejected the stored github_token — it may have expired or been revoked. Save a new one (phantom-cli: /keys)' };
  }
  if (/repository not found/i.test(said)) {
    return { code: 'repo_not_found', retryable: false,
      message: 'GitHub reports the repository was not found — it may not exist, or the stored github_token cannot see it' };
  }
  if (/403|permission|write access|denied|protected branch/i.test(said)) {
    return { code: 'credential_insufficient', retryable: false,
      message: `the stored github_token does not have permission for this (${said.trim().slice(0, 200)})` };
  }
  if (/could not resolve|unable to access|timed out|connection|network is unreachable|early eof|remote end hung up/i.test(said)) {
    return { code: 'upstream_unreachable', retryable: true,
      message: `could not reach GitHub: ${said.trim().slice(0, 200)}` };
  }
  return null;
}

/** A brand-new checkout at `dir`, on `branch`, ready to be worked in.
 *
 *  ONE kind of clone, for a new session, a restarted one and a spare alike:
 *  the whole commit history, none of the past file contents
 *  (--filter=blob:none). Every ancestry question the system asks
 *  (merge-base, is-ancestor, behind/ahead) is answered from commits alone,
 *  so it is always answerable — however long ago a branch left base. A
 *  --depth clone cut the history itself, and a branch older than the cut had
 *  no split point to find. The files of the checked-out commit are fetched
 *  here; a past version is fetched by git at the moment a command reads it,
 *  which is why every checkout/reset below carries `auth`.
 *
 *  --single-branch keeps the fetch refspec to this one branch; a session's
 *  own branch is added to it when the session is checked out. */
export async function cloneFresh(dir: string, auth: GitAuth, branch: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await exec('git', [...guards(auth), 'clone', '--filter=blob:none', '--single-branch', '--branch', branch, auth.url, dir], {
    maxBuffer: 32 * 1024 * 1024, env: gitEnv(auth.pat),
  }).catch(cleanThrow);
  await git(dir, ['config', 'user.name', 'phantom-looper']);
  await git(dir, ['config', 'user.email', 'agent@phantom-looper.local']);
}

/** Bring a checkout KNOWN to hold nothing of its own exactly up to the remote.
 *  Unguarded on purpose — pool slots have never been worked in, so there is
 *  nothing to weigh. Anything a session touched goes through the guarded path. */
export async function refreshPristine(dir: string, auth: GitAuth, branch: string): Promise<void> {
  await git(dir, ['fetch', 'origin', branch], auth);
  await git(dir, ['reset', '--hard', `origin/${branch}`], auth);
}

/** Put `dir` on `branch`, starting from the remote's copy when there is one.
 *
 *  This is the ONE place a session's branch is chosen, and it makes the same
 *  decision for a brand-new session and a restarted one: fetch the branch; if
 *  origin has it, start exactly there. A brand-new session id cannot collide —
 *  the branch name IS the id — so 'existing' only ever means a deliberate
 *  restart, which is why resuming needs no extra state anywhere.
 *
 *  Only "no such ref" counts as absent. A network failure must NOT read as a
 *  new branch: that would start the session at base and orphan everything the
 *  branch already holds. */
export async function checkoutBranch(
  repo: Repo, branch: string, auth: GitAuth,
): Promise<'existing' | 'new'> {
  try {
    await repo.git(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], auth);
  } catch (error) {
    const msg = String((error as { stderr?: string }).stderr ?? error);
    if (!/couldn't find remote ref|not found in upstream|no such ref/i.test(msg)) throw error;
    await repo.git(['checkout', '-B', branch]);
    return 'new';
  }
  await repo.git(['checkout', '-B', branch, `refs/remotes/origin/${branch}`], auth);
  return 'existing';
}

/** Is there anything in this checkout that exists only here?
 *
 *  'no_upstream' is its own answer, not an error: before a session's first
 *  push, `rev-list origin/<branch>..HEAD` is FATAL because the remote ref does
 *  not exist (verified). Callers that treat that as "has work" keep
 *  the never-license-a-wipe property without misreading the first push. */
export type LocalState = 'clean' | 'dirty' | 'unpushed' | 'no_upstream' | 'unknown';

export async function localState(repo: Repo, branch: string): Promise<LocalState> {
  try {
    const { stdout: dirty } = await repo.git(['status', '--porcelain']);
    if (dirty.trim()) return 'dirty';
  } catch (error) {
    log.warn({ err: errStr(error) }, 'git status failed — state is unknown, nothing will be wiped');
    return 'unknown'; // could not tell -> never license a wipe
  }
  try {
    const { stdout: ahead } = await repo.git(['rev-list', '--count', `origin/${branch}..HEAD`]);
    return Number(ahead.trim()) === 0 ? 'clean' : 'unpushed';
  } catch {
    // Before the first push origin/<branch> does not exist — but a session
    // branch that never committed sits exactly on base, and nothing exists
    // only here. Anything HEAD holds that no origin ref holds is real work.
    try {
      const { stdout } = await repo.git(['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']);
      return Number(stdout.trim()) === 0 ? 'clean' : 'no_upstream';
    } catch (error) {
      log.warn({ branch, err: errStr(error) }, 'rev-list failed — counted as unpushed work');
      return 'no_upstream';
    }
  }
}

/** Where a session's work stands on its road to base — /resume's `work`
 *  column. Reads ONLY the checkout's local knowledge of origin (the tracking
 *  refs every push, pull and clone keep fresh) — no network, because the one
 *  door to base is auto-push and it runs from this very directory, so the
 *  local answer is exact for every path the system owns. An out-of-band
 *  merge (a human on GitHub) reads conservatively as not_merged until the
 *  next fetch — never the dangerous direction, since base is never
 *  force-pushed and merged-ness cannot be undone. Verified across 16 repo
 *  states (shallow clones, restarts, conflicted merges included) before
 *  this landed.
 *
 *  null = could not tell (no checkout, git errored): a blank cell, never a
 *  claim. */
export type WorkState = 'not_pushed' | 'not_merged' | 'merged';

export async function workState(
  repo: Repo, branch: string, baseBranch: string,
): Promise<WorkState | null> {
  // "Only this disk has it" is measured against EVERY origin ref, never the
  // session's own branch alone: a pull of base fast-forwards the checkout past
  // origin/<branch> (auto-push skips the branch push when nothing is beyond
  // base), and those commits came FROM origin — they are not unpushed work.
  try {
    const { stdout: dirty } = await repo.git(['status', '--porcelain']);
    if (dirty.trim()) return 'not_pushed';
    const { stdout: local } = await repo.git(['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']);
    if (Number(local.trim()) > 0) return 'not_pushed';
  } catch (error) {
    log.warn({ branch, err: errStr(error) }, 'git status/rev-list failed — no work state for this session');
    return null;
  }
  try {
    await repo.git(['merge-base', '--is-ancestor', 'HEAD', `origin/${baseBranch}`]);
    return 'merged';
  } catch (error) {
    // Exit 1 is git's real "no"; anything else (missing base ref, not a
    // repo) is not knowing, which must never render as a state.
    return (error as { code?: unknown }).code === 1 ? 'not_merged' : null;
  }
}

// ── Git primitives ───────────────────────────────────────────────────────────
// Named for exactly what they do (Shockwave's lesson: a `checkIn` that looked
// complete but stopped at conflicts hid a data-loss path for months). The
// composition into push/pull lives in engine.ts.

/** Stage everything and commit. Returns false when there was nothing to commit.
 *  Does NOT push, and its name says so. */
export async function commitAll(repo: Repo, message: string): Promise<boolean> {
  await repo.git(['add', '-A']);
  const { stdout } = await repo.git(['status', '--porcelain']);
  if (!stdout.trim()) return false;
  await repo.git(['commit', '--no-verify', '-m', message]);
  return true;
}

/** A failure carries git's own words — what the person reads. */
export type PushResult = 'pushed' | 'nothing' | 'conflict' | { error: string };
export const pushFailed = (result: unknown): result is { error: string } => typeof result === 'object' && result !== null && 'error' in result;

/** Push the session branch. One writer, so origin's copy is never NEWER than
 *  HEAD — a rejection means origin holds an OLDER REWRITE of this branch: a
 *  sync whose forced push never ran, or a rebase the agent finished itself
 *  after a conflict was left for it. That history HEAD has already replaced,
 *  so the answer is the forced push with the lease (pushSessionForced).
 *  This used to fold origin's copy back in with a merge, which re-created
 *  the very conflict the rewrite had resolved and left the tree unmerged. */
export async function pushSession(repo: Repo, branch: string, auth: GitAuth): Promise<PushResult> {
  try {
    await repo.git(['push', '--no-verify', 'origin', `HEAD:${branch}`], auth);
    return 'pushed';
  } catch (error) {
    if (!/non-fast-forward|fetch first|rejected/i.test(String((error as { stderr?: string }).stderr ?? error))) {
      log.error({ branch, err: errStr(error) }, 'push failed');
      return { error: errStr(error) };
    }
    log.warn({ branch }, 'push rejected — origin holds an older rewrite of this branch; forcing with the lease');
    return pushSessionForced(repo, branch, auth);
  }
}

export type BasePushResult = 'pushed' | 'rejected' | 'error';

/** Push HEAD to origin/<base> — auto-push's landing. A PLAIN push, deliberately
 *  without pushSession's fold-remote-and-retry backstop: merging the target
 *  branch into the checkout is exactly wrong for base. The caller merged
 *  origin/<base> in first, so this is a fast-forward by construction; a
 *  rejection means base moved and the caller's answer is to merge again.
 *  Never forced. */
export async function pushToBase(repo: Repo, baseBranch: string, auth: GitAuth): Promise<BasePushResult> {
  try {
    await repo.git(['push', '--no-verify', 'origin', `HEAD:${baseBranch}`], auth);
    return 'pushed';
  } catch (error) {
    const said = String((error as { stderr?: string }).stderr ?? error);
    if (/non-fast-forward|fetch first|rejected/i.test(said)) return 'rejected';
    log.error({ baseBranch, err: errStr(error) }, 'push to base failed');
    return 'error';
  }
}

export type RebaseResult = 'clean' | 'conflict' | 'error';

/** Fetch origin/<base> and report what is on it that HEAD does not have. The
 *  log lines are the ONLY briefing the coding agent gets about why a conflict
 *  exists, so they are collected here and carried to the turn. */
export async function fetchBase(
  repo: Repo, baseBranch: string, auth: GitAuth,
): Promise<string[]> {
  await repo.git(['fetch', 'origin', baseBranch], auth);
  const { stdout } = await repo.git(['log', '--format=%h %s', `HEAD..origin/${baseBranch}`]);
  return stdout.trim().split('\n').filter(Boolean);
}

/** Is there anything for a sync to do on this side — uncommitted changes, or
 *  commits the base branch does not have? Asked before anything is written, so
 *  an idle run mints no commit and spends no model call on its message. Reads
 *  only; `status --porcelain` counts untracked files, which `add -A` would
 *  stage. */
export async function hasWorkToLand(repo: Repo, baseBranch: string): Promise<boolean> {
  const { stdout: dirty } = await repo.git(['status', '--porcelain']);
  if (dirty.trim()) return true;
  const { stdout: mergeBase } = await repo.git(['merge-base', 'HEAD', `origin/${baseBranch}`]);
  const { stdout: ahead } = await repo.git(['rev-list', '--count', `${mergeBase.trim()}..HEAD`]);
  return Number(ahead.trim()) > 0;
}

/** Collapse the session's staged work back to ONE commit's worth of staged
 *  content — `reset --soft` to the merge base. The caller has already staged
 *  everything and written the commit message from the staged diff, which is
 *  why the squash comes last: until this runs, HEAD has not moved.
 *
 *  ONE commit is what keeps the rebase to a single conflict stop. Replaying N
 *  commits stops N times, over intermediate trees that never existed as a
 *  working state, re-resolving the same hunks — the cost the squash buys out. */
export async function squashToMergeBase(repo: Repo, mergeBaseSha: string): Promise<void> {
  await repo.git(['reset', '--soft', mergeBaseSha]);
}

/** Commit whatever the squash left staged. */
export async function commitStaged(repo: Repo, message: string): Promise<void> {
  await repo.git(['commit', '--no-verify', '-m', message]);
}

/** Replay the branch onto origin/<base>. The caller has already fetched and
 *  squashed, so this stops at most once.
 *
 *  `conflict` and `error` are distinct on purpose: conflict markers give the
 *  coding agent real work; a rebase that could not START leaves a clean tree
 *  where verification would read as success while the same failure repeats. */
export async function rebaseOntoBase(repo: Repo, baseBranch: string): Promise<RebaseResult> {
  try {
    await repo.git(['rebase', `origin/${baseBranch}`]);
    return 'clean';
  } catch (error) {
    const { stdout: unmerged } = await repo.git(['diff', '--name-only', '--diff-filter=U']);
    if (unmerged.trim()) return 'conflict';
    log.error({ baseBranch, err: errStr(error) }, 'rebase could not start');
    return 'error';
  }
}

/** Is a rebase halted mid-flight? Git keeps one of two state directories while
 *  it is; their absence is the only honest statement that the replay finished.
 *  A tree can be clean with a rebase still stopped, so this is not implied by
 *  the other checks. */
export async function rebaseInProgress(repo: Repo): Promise<boolean> {
  for (const rebaseDir of ['rebase-merge', 'rebase-apply']) {
    if (await repo.exists(`.git/${rebaseDir}`)) return true;
  }
  return false;
}

/** Put the branch back the way it was. The ONE place the system aborts: when it
 *  gives up, so the session is not left mid-rebase and unable to work. The
 *  coding agent must never do this — an abort leaves a clean tree with no
 *  markers, which is why verifyResolved also demands origin/<base> in the
 *  history. */
export async function rebaseAbort(repo: Repo): Promise<void> {
  await repo.git(['rebase', '--abort']).catch(() => {});
}

/** Push the rebased branch. A rebase rewrites the branch, so this must force —
 *  and the lease names the expected value EXPLICITLY, read off the remote a
 *  moment before the push. The bare `--force-with-lease` form is wrong here:
 *  session clones are single-branch (cloneFresh), so the
 *  fetch refspec never maps the session branch, no remote-tracking ref exists
 *  for it, and a bare lease then demands the remote branch NOT exist — it
 *  always does (the backup pushed it), so every push is rejected "stale
 *  info". ls-remote reads the remote's ACTUAL value, which is also a stronger
 *  lease than any local ref.
 *
 *  Deliberately without pushSession's fold-the-remote-in backstop: merging the
 *  remote branch back over a rebase undoes the rebase. */
export async function pushSessionForced(
  repo: Repo, branch: string, auth: GitAuth,
): Promise<PushResult> {
  try {
    const { stdout: listing } = await repo.git(['ls-remote', 'origin', `refs/heads/${branch}`], auth);
    const expected = listing.trim().split(/\s+/)[0] ?? '';
    // Nothing on the remote yet: no lease to hold (a plain create never
    // needs forcing, and --force on a create is harmless).
    const lease = expected ? `--force-with-lease=refs/heads/${branch}:${expected}` : '--force';
    await repo.git(['push', '--no-verify', lease, 'origin', `HEAD:${branch}`], auth);
    return 'pushed';
  } catch (error) {
    log.error({ branch, err: errStr(error) }, 'forced branch push failed');
    return { error: errStr(error) };
  }
}

/** WHY a landing fails verification, in plain words — the explicit failure
 *  notice a blocked sync owes the person (and the exact checks the conflict
 *  prompt tells the agent it will be held to). [] = landed. Run against the
 *  directory, never against what the agent said it did.
 *
 *  The last two checks are not decoration. `git rebase --abort` leaves a clean
 *  tree with no unmerged entries, so the first checks alone call a give-up a
 *  success: the caller then logs "resolved", pushes, and the same conflict
 *  returns forever. Requiring origin/<base> to be an ancestor of HEAD is the
 *  only statement of "the replay is in". */
export async function landingProblems(repo: Repo, baseBranch?: string): Promise<string[]> {
  const problems: string[] = [];
  try {
    const { stdout: status } = await repo.git(['status', '--porcelain']);
    if (status.trim()) problems.push('the working tree has uncommitted changes');
    const { stdout: unmerged } = await repo.git(['diff', '--name-only', '--diff-filter=U']);
    if (unmerged.trim()) problems.push(`conflicts are still unmerged in: ${unmerged.trim().split('\n').join(', ')}`);
    if (await rebaseInProgress(repo)) {
      problems.push('the rebase is still in progress — git rebase --continue was not run or did not finish');
    }
    if (baseBranch) {
      try {
        await repo.git(['merge-base', '--is-ancestor', `origin/${baseBranch}`, 'HEAD']);
      } catch (error) {
        // Exit 1 is git's real "not an ancestor" — the verdict. Anything else
        // (no repo, no origin ref) is the check itself failing.
        if ((error as { code?: unknown }).code === 1) {
          problems.push(`origin/${baseBranch} is not contained in the result — the replay is not in`);
        } else {
          log.warn({ err: (error as Error).message }, 'verification could not run — counted as not landed');
          problems.push(`verification itself failed: ${(error as Error).message}`);
        }
      }
    }
  } catch (error) {
    log.warn({ err: (error as Error).message }, 'verification could not run — counted as not landed');
    problems.push(`verification itself failed: ${(error as Error).message}`);
  }
  return problems;
}

/** Clean tree AND no unmerged entries AND no rebase still in flight AND
 *  origin/<base> in HEAD's history. The boolean form of landingProblems. */
export async function verifyLanded(repo: Repo, baseBranch?: string): Promise<boolean> {
  return (await landingProblems(repo, baseBranch)).length === 0;
}

/** Give a brand-new empty remote its first commit on `branch` (a README), so
 *  the base branch exists under the name we chose and every clone path works.
 *  Runs in a scratch directory with the full guard set; `pushUrl` is the
 *  remote's clone URL as GitHub reported it. */
export async function initializeRemote(
  pushUrl: string, branch: string, auth: GitAuth, readme: string,
): Promise<void> {
  const os = await import('node:os');
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'phantom-init-'));
  try {
    await exec('git', ['init', '-q', '-b', branch, tmp]);
    await fs.writeFile(path.join(tmp, 'README.md'), readme);
    await git(tmp, ['config', 'user.name', 'phantom-looper']);
    await git(tmp, ['config', 'user.email', 'agent@phantom-looper.local']);
    await git(tmp, ['add', '-A']);
    await git(tmp, ['commit', '--no-verify', '-q', '-m', 'Initial commit']);
    await git(tmp, ['push', '--no-verify', pushUrl, `HEAD:${branch}`], { ...auth, url: pushUrl });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
