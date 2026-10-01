// Self-update: the cli and the server are cut from ONE tag (release.yml), so
// "is anything behind" is comparing version strings that came from the same
// commit. The pieces, all here:
//
//   - APP_VERSION — baked in by build-cli.sh (an esbuild define); 'dev' from
//     a checkout. 'dev' is never stale and never offered updates, or every
//     development session would nag.
//   - checkLatest / isBehind — one GET of the latest published release.
//     Drafts never appear (the workflow publishes atomically) and GitHub's
//     `latest` excludes prereleases by itself.
//   - installVersion — THE owner of the versions folder and the launcher.
//     Both ways a build lands on a machine end here: `phantom-cli update`
//     (selfUpdate below: download, verify, unpack) and `curl | sh`
//     (install-cli.sh: download, verify, unpack, then `phantom-cli install`
//     from the unpacked folder). The shell script knows nothing about
//     versions, links or cleanup — same split as Claude Code's installer.
//
// On disk:
//
//   ~/.phantom-cli/app/<version>/    one folder per version — complete or absent
//   ~/.phantom-cli/app/.staging-<pid>/  an unpack in progress
//   ~/.local/bin/phantom-cli  ->  app/<version>/bin/phantom-cli
//
// The rules installVersion keeps, each one a scar from Claude Code's changelog:
//   - staging lives INSIDE app/, so moving it into place is one rename on one
//     filesystem — atomic, and never half a folder (a /tmp on its own mount
//     cannot be renamed across).
//   - the launcher is swapped by renaming a new link over the old one — there
//     is no instant with no command.
//   - the running version's folder is never deleted or replaced: its files
//     are still open.
//   - cleanup (pruneVersions, after every install) keeps
//     the two newest versions (current + one to fall back to, one `ln -sf`
//     away offline), the one the launcher points at, and the one running.
//     Every other version goes — each carries its own Node (~110 MB), and
//     before this rule daily auto-update kept every release ever installed.
//
// The update is offered, never automatic: a notice at quit, applied by
// `phantom-cli update` — both halves, or `--client` / `--server`. The command,
// its messages and the server wait live in update.ts.
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONFIG_DIR } from './config.js';

// Version primitives live in core/ so the server can share them.
import { REPO, isBehind } from '../core/version.js';
export { REPO, parseVersion, isBehind, checkLatest } from '../core/version.js';

// esbuild --define replaces this whole expression with the release string; a
// checkout (tsx) reads nothing and stays 'dev'.
export const APP_VERSION: string = process.env.PHANTOM_CLI_VERSION ?? 'dev';

/** Where installed versions live, and the one launcher that names the current one. */
export const APP_ROOT = join(CONFIG_DIR, 'app');
export const LAUNCHER = join(homedir(), '.local', 'bin', 'phantom-cli');

/** The folder this build runs from (app/<version>): lib/phantom-cli.mjs is
 *  the bundle, so one up from the module. A checkout has no such folder. */
export function thisBuildDir(): string { return resolve(import.meta.dirname, '..'); }

export function platformAsset(platform = process.platform, arch = process.arch): string {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
  const a = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : null;
  if (!os || !a) throw new Error(`no phantom-cli build for ${platform}/${arch}`);
  return `phantom-cli-${os}-${a}.tar.gz`;
}

/** The sha256 recorded for an asset in a release's checksums.txt. */
export function checksumFor(checksums: string, asset: string): string | null {
  for (const line of checksums.split('\n')) {
    const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (m && m[2] === asset) return m[1];
  }
  return null;
}

// ── the versions folder ─────────────────────────────────────────────────────

// Work folders inside app/, all `.<kind>-<pid>`: staging (an unpack in
// progress), old (a folder being replaced). The pid says whose; a dead pid's
// folder is anyone's to delete.
const scratch = (appRoot: string, kind: string) => join(appRoot, `.${kind}-${process.pid}`);
const scratchPid = (name: string): number | null => { const m = /^\.[a-z]+-(\d+)/.exec(name); return m ? Number(m[1]) : null; };

/** The version a launcher link points at, or null when there is no link or
 *  it points outside appRoot (a hand-made launcher — left alone). */
export function linkedVersion(launcher: string, appRoot = APP_ROOT): string | null {
  let target: string;
  try { target = readlinkSync(launcher); } catch { return null; }
  if (!isAbsolute(target)) target = resolve(dirname(launcher), target);
  const versionDir = dirname(dirname(target));
  return dirname(versionDir) === appRoot ? basename(versionDir) : null;
}

/** Every complete version on disk (a folder carrying our VERSION file). */
export function installedVersions(appRoot = APP_ROOT): string[] {
  let names: string[];
  try { names = readdirSync(appRoot); } catch { return []; }
  return names.filter((n) => !n.startsWith('.') && existsSync(join(appRoot, n, 'VERSION')));
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** How many of the newest versions survive a prune: the current one and one
 *  to fall back to. */
export const KEEP_NEWEST = 2;

export interface Layout {
  appRoot?: string; launcher?: string;
  /** The folder whose files this process has open — never deleted or
   *  replaced. app/<version> for an installed build; a checkout's folder is
   *  not under app/ and so protects nothing. */
  inUse?: string;
}

function versionOf(dir: string, appRoot: string): string | null {
  return dirname(dir) === appRoot ? basename(dir) : null;
}

/** Delete every version that is not: one of the KEEP_NEWEST newest, the one
 *  the launcher points at, or the one running — and every work folder whose
 *  process is gone. Runs after every install (the update process, never a
 *  launch), so the folder never grows past that. Never throws — leftovers
 *  are a nuisance, not a failure; the next install tries again. */
export function pruneVersions(opts: Layout = {}): string[] {
  const appRoot = opts.appRoot ?? APP_ROOT;
  const launcher = opts.launcher ?? LAUNCHER;
  const inUse = resolve(opts.inUse ?? thisBuildDir());
  const newest = installedVersions(appRoot)
    .sort((a, b) => (isBehind(a, b) ? 1 : isBehind(b, a) ? -1 : 0))
    .slice(0, KEEP_NEWEST);
  const keep = new Set([...newest, linkedVersion(launcher, appRoot), versionOf(inUse, appRoot)]);
  const removed: string[] = [];
  const drop = (name: string) => {
    try { rmSync(join(appRoot, name), { recursive: true, force: true }); removed.push(name); } catch { /* next time */ }
  };
  for (const v of installedVersions(appRoot)) if (!keep.has(v)) drop(v);
  let names: string[] = [];
  try { names = readdirSync(appRoot); } catch { /* nothing to sweep */ }
  for (const n of names) {
    const pid = scratchPid(n);
    if (pid !== null && !pidAlive(pid)) drop(n);
  }
  return removed;
}

/** Swap the launcher to point at target: a fresh link renamed over the old
 *  one, so no launch ever finds the command missing. */
function relink(launcher: string, target: string): void {
  mkdirSync(dirname(launcher), { recursive: true });
  const fresh = `${launcher}.new-${process.pid}`;
  rmSync(fresh, { force: true });
  symlinkSync(target, fresh);
  renameSync(fresh, launcher);
}

export interface InstallResult { version: string; removed: string[] }

/** Make `staged` — an unpacked release folder, normally app/.staging-<pid> —
 *  the current version. Moves it to app/<version>, swaps the launcher, prunes.
 *  `staged` may already BE app/<version> (a `phantom-cli install` run from an
 *  installed folder): then this only repairs the launcher and prunes. */
export function installVersion(staged: string, opts: Layout = {}): InstallResult {
  const appRoot = opts.appRoot ?? APP_ROOT;
  const launcher = opts.launcher ?? LAUNCHER;
  const inUse = resolve(opts.inUse ?? thisBuildDir());

  const version = readFileSync(join(staged, 'VERSION'), 'utf8').trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`${staged} has no valid VERSION file`);
  const dest = join(appRoot, version);
  mkdirSync(appRoot, { recursive: true });

  if (resolve(staged) !== resolve(dest)) {
    if (existsSync(dest)) {
      if (resolve(dest) === inUse) {
        // The folder in use IS this version — its files stay; the bytes are
        // the same (checksum-verified), so the staged copy is redundant.
        rmSync(staged, { recursive: true, force: true });
      } else {
        // Another window landed it first, or a reinstall: move the old folder
        // aside, drop the new one in, then delete the old — dest is never
        // half-populated.
        const aside = scratch(appRoot, 'old');
        renameSync(dest, aside);
        renameSync(staged, dest);
        rmSync(aside, { recursive: true, force: true });
      }
    } else {
      renameSync(staged, dest);
    }
  }
  chmodSync(join(dest, 'bin', 'phantom-cli'), 0o755);

  relink(launcher, join(dest, 'bin', 'phantom-cli'));
  return { version, removed: pruneVersions({ appRoot, launcher, inUse }) };
}

// ── the download half ───────────────────────────────────────────────────────

/** Download tag's tarball for this platform, verify it against the release's
 *  checksums.txt, unpack into staging and hand it to installVersion. Returns
 *  the human line to print. */
export async function selfUpdate(tag: string, opts: {
  fetchFn?: typeof fetch; repo?: string; appRoot?: string; launcher?: string;
} = {}): Promise<string> {
  if (APP_VERSION === 'dev') throw new Error('a checkout updates with git pull — self-update is for installed builds');
  const fetchFn = opts.fetchFn ?? fetch;
  const repo = opts.repo ?? REPO;
  const appRoot = opts.appRoot ?? APP_ROOT;
  const asset = platformAsset();
  const base = `https://github.com/${repo}/releases/download/${tag}`;

  const [tarR, sumR] = await Promise.all([
    fetchFn(`${base}/${asset}`), fetchFn(`${base}/checksums.txt`),
  ]);
  if (!tarR.ok) throw new Error(`could not download ${base}/${asset} (HTTP ${tarR.status})`);
  if (!sumR.ok) throw new Error(`could not download the release's checksums.txt (HTTP ${sumR.status})`);
  const tarball = Buffer.from(await tarR.arrayBuffer());
  const want = checksumFor(await sumR.text(), asset);
  if (!want) throw new Error(`checksums.txt has no entry for ${asset}`);
  const got = createHash('sha256').update(tarball).digest('hex');
  if (got !== want) throw new Error(`checksum mismatch for ${asset} — refusing to install it`);

  // Staging inside app/ — same filesystem as its destination, so the move
  // into place is one atomic rename. A crash leaves .staging-<pid>, which the
  // next install's prune sweeps once the pid is gone.
  const work = scratch(appRoot, 'staging');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  let staged: string;
  try {
    const tarPath = join(work, asset);
    writeFileSync(tarPath, tarball);
    const untar = spawnSync('tar', ['-C', work, '-xzf', tarPath], { stdio: 'pipe' });
    if (untar.status !== 0) throw new Error(`could not unpack ${asset}: ${untar.stderr}`);
    rmSync(tarPath, { force: true });
    // The tarball's root folder is phantom-cli/; lift it out so staging IS the build.
    staged = join(work, 'phantom-cli');
  } catch (e) {
    rmSync(work, { recursive: true, force: true });
    throw e;
  }
  const r = installVersion(staged, { appRoot, launcher: opts.launcher });
  rmSync(work, { recursive: true, force: true });
  return `phantom-cli ${r.version} installed — next launch runs it`;
}
