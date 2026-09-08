// Self-update: the cli and the server are cut from ONE tag (release.yml), so
// "is anything behind" is comparing version strings that came from the same
// commit. Three pieces, all here:
//
//   - APP_VERSION — baked in by build-cli.sh (an esbuild define); 'dev' from
//     a checkout. 'dev' is never stale and never offered updates, or every
//     development session would nag.
//   - checkLatest / isBehind — one GET of the latest published release.
//     Drafts never appear (the workflow publishes atomically) and GitHub's
//     `latest` excludes prereleases by itself.
//   - selfUpdate — download the tarball for THIS platform, verify it against
//     the release's checksums.txt, unpack beside the running version under
//     CONFIG_DIR/app/<version>, and move the ONE symlink. The running
//     process is never touched: the new version is next launch's.
//
// The update is offered, never automatic: a notice at quit, applied by
// `phantom-cli update` — both halves, or `--client` / `--server`. The command,
// its messages and the server wait live in update.ts; this file is the
// client half's mechanics plus the version compare both halves use.
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { CONFIG_DIR } from './config.js';

// Version primitives live in core/ so the server can share them.
import { REPO as _REPO } from '../core/version.js';
export { REPO, parseVersion, isBehind, checkLatest } from '../core/version.js';
// Local alias so selfUpdate() below can reference it.
const REPO = _REPO;

// esbuild --define replaces this whole expression with the release string; a
// checkout (tsx) reads nothing and stays 'dev'.
export const APP_VERSION: string = process.env.PHANTOM_CLI_VERSION ?? 'dev';

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

/** Download tag's tarball for this platform, verify, unpack, re-link. Returns
 *  the human line to print. The symlink move is the whole switch — the old
 *  version stays on disk until an update replaces its directory. */
export async function selfUpdate(tag: string, opts: {
  fetchFn?: typeof fetch; repo?: string; dir?: string; home?: string; binDir?: string;
} = {}): Promise<string> {
  if (APP_VERSION === 'dev') throw new Error('a checkout updates with git pull — self-update is for installed builds');
  const fetchFn = opts.fetchFn ?? fetch;
  const repo = opts.repo ?? REPO;
  const home = opts.home ?? homedir();
  const dir = opts.dir ?? CONFIG_DIR;
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

  const version = tag.replace(/^v/, '');
  const appDir = join(dir, 'app', version);
  const work = join(tmpdir(), `phantom-cli-update-${process.pid}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  try {
    const tarPath = join(work, asset);
    writeFileSync(tarPath, tarball);
    const untar = spawnSync('tar', ['-C', work, '-xzf', tarPath], { stdio: 'pipe' });
    if (untar.status !== 0) throw new Error(`could not unpack ${asset}: ${untar.stderr}`);
    rmSync(appDir, { recursive: true, force: true });
    mkdirSync(join(dir, 'app'), { recursive: true });
    renameSync(join(work, 'phantom-cli'), appDir);
    chmodSync(join(appDir, 'bin', 'phantom-cli'), 0o755);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  // ONE symlink is the switch — same rule as install-cli.sh. ln -sf via
  // unlink+symlink so a broken existing link cannot make this fail.
  const binDir = opts.binDir ?? join(home, '.local', 'bin');
  mkdirSync(binDir, { recursive: true });
  const link = join(binDir, 'phantom-cli');
  try { unlinkSync(link); } catch { /* absent is fine */ }
  symlinkSync(join(appDir, 'bin', 'phantom-cli'), link);
  return `phantom-cli ${version} installed — next launch runs it`;
}
