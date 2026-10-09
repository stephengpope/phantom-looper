// `phantom-cli runner` — a session runner on THIS machine: a box that runs your
// workspaces for the backend you are paired with. Docker runs it, from the
// same compose file a server runs (session-runner/ in the
// release image): `start` extracts that file from the release's image,
// writes its .env from the pairing (the url, the key, this machine's name),
// and brings it up; `stop` takes it down (the volume stays); `status` asks
// the backend what it sees.
//
//   phantom-cli runner start [--name <label>] [--tag <vX.Y.Z>]
//   phantom-cli runner stop
//   phantom-cli runner status
//   phantom-cli runner logs
//
// The key is the one the cli holds: the service role key makes a SHARED runner
// (any workspace may land here); your own user role key makes YOUR host (your
// workspaces alone). The key's prefix says which. Nothing listens on this machine — the host dials out.
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { CONFIG_DIR } from './config.js';
import { localValues } from './local.js';
import { savedCaFor, apiFor } from './provision.js';
import { APP_VERSION } from './selfUpdate.js';

const HOST_DIR = join(CONFIG_DIR, 'runner');
const IMAGE = 'ghcr.io/stephengpope/phantom-backend';

function sh(command: string, args: string[], opts: { cwd?: string; capture?: boolean } = {}): SpawnSyncReturns<string> {
  return spawnSync(command, args, { cwd: opts.cwd, encoding: 'utf8', stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
}

/** The release tag this cli runs — the backend runs the same (one SDK version). */
const tagOf = (flag: string | undefined) => flag ?? (/^v\d+\.\d+\.\d+/.test(`v${APP_VERSION}`) && APP_VERSION !== 'dev' ? `v${APP_VERSION}` : 'latest');

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

/** The compose file and its .env, from the release image: the same files an
 *  server runs. Extracted with `docker cp` out of a created
 *  container, as updater/apply.sh does — the image is the one artifact. */
function extractComposeFiles(tag: string): void {
  mkdirSync(HOST_DIR, { recursive: true, mode: 0o700 });
  const image = `${IMAGE}:${tag}`;
  if (sh('docker', ['image', 'inspect', image], { capture: true }).status !== 0) {
    console.log(`pulling ${image}`);
    const pulled = sh('docker', ['pull', image]);
    if (pulled.status !== 0) throw new Error(`could not pull ${image}`);
  }
  const created = sh('docker', ['create', image], { capture: true });
  if (created.status !== 0) throw new Error(`could not create a container from ${image}: ${created.stderr}`);
  const cid = created.stdout.trim();
  try {
    const copied = sh('docker', ['cp', `${cid}:/host-files/session-runner/.`, `${HOST_DIR}/`], { capture: true });
    if (copied.status !== 0) throw new Error(`the image has no session-runner files (released before session runners?): ${copied.stderr}`);
  } finally {
    sh('docker', ['rm', '-f', cid], { capture: true });
  }
}

/** One .env value, double-quoted for compose's parser; a PEM's newlines ride as \n. */
const quoted = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;

function writeEnv(values: Record<string, string>): void {
  const text = Object.entries(values).map(([key, value]) => `${key}=${quoted(value)}`).join('\n') + '\n';
  const path = join(HOST_DIR, '.env');
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function compose(args: string[]): number {
  return sh('docker', ['compose', ...args], { cwd: HOST_DIR }).status ?? 1;
}

export async function runRunner(args: string[]): Promise<number> {
  const command = args[0];
  const usage = () => { console.log('usage: phantom-cli runner start [--name <label>] [--tag <vX.Y.Z>] | stop | status | logs'); return 2; };
  if (!command || command === '--help' || command === '-h') return usage();

  const local = localValues();
  const url = String(local.server_url ?? '');
  const key = String(local.service_role_key ?? '');
  if (!url || !key) { console.error('no backend paired — run setup-backend, or /server in the app'); return 1; }

  if (command === 'start') {
    const tag = tagOf(flag(args, '--tag'));
    const name = flag(args, '--name') ?? hostname();
    try { extractComposeFiles(tag); } catch (error) { console.error((error as Error).message); return 1; }
    const ca = savedCaFor(url);
    writeEnv({
      BACKEND_URL: url, BACKEND_KEY: key, HOST_NAME: name, BACKEND_TAG: tag,
      BACKEND_CA: ca ?? '',
    });
    console.log(`starting session runner "${name}" for ${url} (${IMAGE}:${tag})`);
    const code = compose(['up', '-d']);
    if (code === 0) console.log('session runner up — `phantom-cli runner status` shows what the backend sees, `phantom-cli runner logs` follows it');
    return code;
  }
  if (!existsSync(join(HOST_DIR, 'docker-compose.yml'))) { console.error('no session runner on this machine — phantom-cli runner start'); return 1; }
  if (command === 'stop') return compose(['down']);
  if (command === 'logs') return compose(['logs', '-f', 'session-runner']);
  if (command === 'status') {
    compose(['ps']);
    try {
      const listed = await apiFor(url, key, savedCaFor(url))('GET', '/session-runners') as { hosts: Array<{ id: string; name: string; online: boolean; ownerUserId: string | null; workspaces: number; connectedAt: string | null; load: { cpu: number; freeGB: number; usedPct: number; running: number } | null }> };
      if (!listed.hosts.length) { console.log('the backend knows no session runners'); return 0; }
      console.log('\nthe backend sees:');
      for (const host of listed.hosts) {
        const load = host.load ? `  cpu ${host.load.cpu.toFixed(2)}  ${host.load.running} running  ${Math.round(host.load.freeGB)} GB free` : '';
        console.log(`  ${host.online ? '●' : '○'} ${host.name}  ${host.ownerUserId ? 'user runner' : 'shared runner'}  ${host.workspaces} workspace${host.workspaces === 1 ? '' : 's'}${load}  ${host.online ? 'online' : `offline${host.connectedAt ? ` (last ${host.connectedAt})` : ''}`}  ${host.id}`);
      }
    } catch (error) { console.error(`could not ask the backend: ${(error as Error).message}`); return 1; }
    return 0;
  }
  return usage();
}
