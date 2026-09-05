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
import { logger, errStr } from '../log.js';

const exec = promisify(execFile);
const log = logger('git');

/** Answers git's credential prompt from the env var set on that one call.
 *  Passed on the command line — never a script on disk the agent could rewrite. */
const CREDENTIAL_HELPER = '!f() { echo username=x-access-token; echo password=$GITHUB_PAT; }; f';

/** NOT a directory. Git looks up `<hooksPath>/<hookname>`, and a path under the
 *  null device is ENOTDIR, so no hook is ever found — and unlike an empty
 *  directory there is nothing to keep empty. */
const NO_HOOKS = '/dev/null';

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
function cleanThrow(e: unknown): never {
  const x = e as Error & { stderr?: string; stdout?: string; code?: unknown };
  const said = typeof x?.stderr === 'string' ? x.stderr.trim() : '';
  if (!said) throw e;
  const err = new Error(`git: ${said}`) as Error & { stderr?: string; stdout?: string; code?: unknown };
  err.stderr = x.stderr; err.stdout = x.stdout; err.code = x.code;
  throw err;
}

export async function git(
  cwd: string, args: string[], auth?: GitAuth,
): Promise<{ stdout: string; stderr: string }> {
  if (!auth) return exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 }).catch(cleanThrow);
  return exec('git', [...guards(auth), ...args], {
    cwd, maxBuffer: 32 * 1024 * 1024, env: gitEnv(auth.pat),
  }).catch(cleanThrow);
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

export function classifyGitFailure(e: unknown, opts: { hadToken?: boolean } = {}):
  { code: GitFailureCode; message: string; retryable: boolean } | null {
  const said = String((e as { stderr?: string })?.stderr ?? (e as Error)?.message ?? e);
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

/** A brand-new shallow checkout at `dir`, on `branch`, ready to be worked in.
 *
 *  --depth=1 belongs on the initial clone and ONLY there. Deepening to
 *  `historyDepth` is a separate, best-effort fetch: folded into the clone as
 *  --shallow-since it fails outright on a repo with no commits in the window
 *  and no directory is created (verified); as a second step the
 *  identical failure is harmless. And never --depth on a later fetch — it
 *  re-grafts the branch as a disconnected root and silently inverts every
 *  ancestry check downstream (verified). */
export async function cloneFresh(
  dir: string, auth: GitAuth, branch: string, historyDepth: string,
): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dir), { recursive: true });
  const depthArgs = historyDepth === 'full' ? [] : ['--depth=1'];
  await exec('git', [...guards(auth), 'clone', ...depthArgs, '--branch', branch, auth.url, dir], {
    maxBuffer: 32 * 1024 * 1024, env: gitEnv(auth.pat),
  }).catch(cleanThrow);
  if (historyDepth !== 'full') {
    await git(dir, ['fetch', `--shallow-since=${historyDepth}`, 'origin', branch], auth)
      .catch((e) => log.debug({ dir, err: errStr(e) }, 'no history in window — staying at depth 1'));
  }
  await git(dir, ['config', 'user.name', 'phantom-looper']);
  await git(dir, ['config', 'user.email', 'agent@phantom-looper.local']);
}

/** Bring a checkout KNOWN to hold nothing of its own exactly up to the remote.
 *  Unguarded on purpose — pool slots have never been worked in, so there is
 *  nothing to weigh. Anything a session touched goes through the guarded path. */
export async function refreshPristine(dir: string, auth: GitAuth, branch: string): Promise<void> {
  await git(dir, ['fetch', 'origin', branch], auth);
  await git(dir, ['reset', '--hard', `origin/${branch}`]);
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
  dir: string, branch: string, auth: GitAuth,
): Promise<'existing' | 'new'> {
  try {
    await git(dir, ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], auth);
  } catch (e) {
    const msg = String((e as { stderr?: string }).stderr ?? e);
    if (!/couldn't find remote ref|not found in upstream|no such ref/i.test(msg)) throw e;
    await git(dir, ['checkout', '-B', branch]);
    return 'new';
  }
  await git(dir, ['checkout', '-B', branch, `refs/remotes/origin/${branch}`]);
  return 'existing';
}

/** Is there anything in this checkout that exists only here?
 *
 *  'no_upstream' is its own answer, not an error: before a session's first
 *  push, `rev-list origin/<branch>..HEAD` is FATAL because the remote ref does
 *  not exist (verified). Callers that treat that as "has work" keep
 *  the never-license-a-wipe property without misreading the first push. */
export type LocalState = 'clean' | 'dirty' | 'unpushed' | 'no_upstream' | 'unknown';

export async function localState(dir: string, branch: string): Promise<LocalState> {
  try {
    const { stdout: dirty } = await git(dir, ['status', '--porcelain']);
    if (dirty.trim()) return 'dirty';
  } catch {
    return 'unknown'; // could not tell -> never license a wipe
  }
  try {
    const { stdout: ahead } = await git(dir, ['rev-list', '--count', `origin/${branch}..HEAD`]);
    return Number(ahead.trim()) === 0 ? 'clean' : 'unpushed';
  } catch {
    // Before the first push origin/<branch> does not exist — but a session
    // branch that never committed sits exactly on base, and nothing exists
    // only here. Anything HEAD holds that no origin ref holds is real work.
    try {
      const { stdout } = await git(dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']);
      return Number(stdout.trim()) === 0 ? 'clean' : 'no_upstream';
    } catch {
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
  dir: string, branch: string, baseBranch: string,
): Promise<WorkState | null> {
  // "Only this disk has it" is measured against EVERY origin ref, never the
  // session's own branch alone: a pull of base fast-forwards the checkout past
  // origin/<branch> (auto-push skips the branch push when nothing is beyond
  // base), and those commits came FROM origin — they are not unpushed work.
  try {
    const { stdout: dirty } = await git(dir, ['status', '--porcelain']);
    if (dirty.trim()) return 'not_pushed';
    const { stdout: local } = await git(dir, ['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']);
    if (Number(local.trim()) > 0) return 'not_pushed';
  } catch {
    return null;
  }
  try {
    await git(dir, ['merge-base', '--is-ancestor', 'HEAD', `origin/${baseBranch}`]);
    return 'merged';
  } catch (e) {
    // Exit 1 is git's real "no"; anything else (missing base ref, not a
    // repo) is not knowing, which must never render as a state.
    return (e as { code?: unknown }).code === 1 ? 'not_merged' : null;
  }
}

// ── Git primitives ───────────────────────────────────────────────────────────
// Named for exactly what they do (Shockwave's lesson: a `checkIn` that looked
// complete but stopped at conflicts hid a data-loss path for months). The
// composition into push/pull lives in engine.ts.

/** Stage everything and commit. Returns false when there was nothing to commit.
 *  Does NOT push, and its name says so. */
export async function commitAll(dir: string, message: string): Promise<boolean> {
  await git(dir, ['add', '-A']);
  const { stdout } = await git(dir, ['status', '--porcelain']);
  if (!stdout.trim()) return false;
  await git(dir, ['commit', '--no-verify', '-m', message]);
  return true;
}

export type PushResult = 'pushed' | 'nothing' | 'conflict' | 'error';
export type PullResult = 'clean' | 'merged' | 'conflict' | 'diverged' | 'dirty_tree' | 'error';

const PUSH_ATTEMPTS = 3;

/** Push the session branch. One writer means this cannot conflict by design;
 *  the fetch+merge retry is a backstop for a resumed session that diverged
 *  after a re-clone — not a conflict path to build on. */
export async function pushSession(dir: string, branch: string, auth: GitAuth): Promise<PushResult> {
  try {
    for (let attempt = 0; attempt < PUSH_ATTEMPTS; attempt++) {
      try {
        await git(dir, ['push', '--no-verify', 'origin', `HEAD:${branch}`], auth);
        return 'pushed';
      } catch (e) {
        if (!/non-fast-forward|fetch first|rejected/i.test(String((e as { stderr?: string }).stderr ?? e))) throw e;
        log.warn({ dir, branch, attempt: attempt + 1 }, 'push rejected — folding remote in and retrying');
        await git(dir, ['fetch', 'origin', branch], auth);
        try {
          await git(dir, ['merge', '--no-edit', '--no-verify', `origin/${branch}`]);
        } catch {
          const { stdout: unmerged } = await git(dir, ['diff', '--name-only', '--diff-filter=U']);
          if (unmerged.trim()) return 'conflict';
          throw e;
        }
      }
    }
    return 'conflict';
  } catch (e) {
    log.error({ dir, branch, err: errStr(e) }, 'push failed');
    return 'error';
  }
}

export type BasePushResult = 'pushed' | 'rejected' | 'error';

/** Push HEAD to origin/<base> — auto-push's landing. A PLAIN push, deliberately
 *  without pushSession's fold-remote-and-retry backstop: merging the target
 *  branch into the checkout is exactly wrong for base. The caller merged
 *  origin/<base> in first, so this is a fast-forward by construction; a
 *  rejection means base moved and the caller's answer is to merge again.
 *  Never forced. */
export async function pushToBase(dir: string, baseBranch: string, auth: GitAuth): Promise<BasePushResult> {
  try {
    await git(dir, ['push', '--no-verify', 'origin', `HEAD:${baseBranch}`], auth);
    return 'pushed';
  } catch (e) {
    const s = String((e as { stderr?: string }).stderr ?? e);
    if (/non-fast-forward|fetch first|rejected/i.test(s)) return 'rejected';
    log.error({ dir, baseBranch, err: errStr(e) }, 'push to base failed');
    return 'error';
  }
}

/** Merge origin/<base> into the session branch. MERGE, never rebase: rebase
 *  rewrites pushed commits and forces the next push (verified T4); merge keeps
 *  the branch append-only so no push is ever forced.
 *
 *  `conflict` and `diverged` are distinct on purpose: markers in the tree give
 *  the Git Fixer real work; a merge that could not START leaves a clean tree
 *  where the Git Fixer verifies success while the same failure repeats (verified T9). */
export async function mergeBase(
  dir: string, baseBranch: string, auth: GitAuth, message?: string,
): Promise<{ result: PullResult; arrived?: string[] }> {
  try {
    const { stdout: dirty } = await git(dir, ['status', '--porcelain']);
    if (dirty.trim()) return { result: 'dirty_tree' };
    await git(dir, ['fetch', 'origin', baseBranch], auth);
    const { stdout: behind } = await git(dir, ['rev-list', '--count', `HEAD..origin/${baseBranch}`]);
    if (Number(behind.trim()) === 0) return { result: 'clean' };
    const { stdout: logOut } = await git(dir, ['log', '--format=%h %s', `HEAD..origin/${baseBranch}`]);
    try {
      await git(dir, ['merge', '--no-edit', '--no-verify', ...(message ? ['-m', message] : []), `origin/${baseBranch}`]);
    } catch (e) {
      const { stdout: unmerged } = await git(dir, ['diff', '--name-only', '--diff-filter=U']);
      if (unmerged.trim()) return { result: 'conflict' };
      log.error({ dir, err: errStr(e) }, 'merge could not start — diverged');
      return { result: 'diverged' };
    }
    return { result: 'merged', arrived: logOut.trim().split('\n').filter(Boolean) };
  } catch (e) {
    log.error({ dir, err: errStr(e) }, 'pull failed');
    return { result: 'error' };
  }
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
