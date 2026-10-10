// `phantom-cli runner` — the runners on THIS machine: a session runner that
// runs your workspaces and a client runner that runs turns, for the backend
// you are paired with. Docker runs them from one compose file (runners/ in
// the release image): `start` extracts it from the release's image, writes
// its .env from the pairing (the url, the key, this machine's name), and
// brings both up; `stop` takes them down (the volume stays); `status` asks
// the backend what it sees.
//
//   phantom-cli runner start [--name <label>] [--tag <vX.Y.Z>]
//   phantom-cli runner stop
//   phantom-cli runner status
//   phantom-cli runner logs
//   phantom-cli runner update [vX.Y.Z]     this machine's runner, through the backend
//
// The key is the one the cli holds: the service role key makes a SHARED runner
// (any workspace may land here); your own user role key makes YOUR host (your
// workspaces alone). The key's prefix says which. Nothing listens on this machine — the host dials out.
import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { CONFIG_DIR } from './config.js';
import { localValues } from './local.js';
import { savedCaFor, apiFor, streamFor } from './provision.js';
import { APP_VERSION, checkLatest } from './selfUpdate.js';
import { updateRunners, listRunners, bare } from './update.js';

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
    const copied = sh('docker', ['cp', `${cid}:/host-files/runners/.`, `${HOST_DIR}/`], { capture: true });
    if (copied.status !== 0) throw new Error(`the image has no runners/ files (released before runners?): ${copied.stderr}`);
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

/** One value out of the stack's .env (the cli wrote it, quoted). */
function envValue(name: string): string | undefined {
  try {
    const line = readFileSync(join(HOST_DIR, '.env'), 'utf8').split('\n').find((one) => one.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).replace(/^"(.*)"$/, '$1') || undefined : undefined;
  } catch { return undefined; }
}

function compose(args: string[]): number {
  return sh('docker', ['compose', ...args], { cwd: HOST_DIR }).status ?? 1;
}

export async function runRunner(args: string[]): Promise<number> {
  const command = args[0];
  const usage = () => { console.log('usage: phantom-cli runner start [--name <label>] [--tag <vX.Y.Z>] | stop | status | logs | update [vX.Y.Z]'); return 2; };
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
      // The updater sidecar's: this directory, and a helper container name
      // that is this stack's alone on the daemon.
      RUNNER_DIR: HOST_DIR, HELPER_NAME: `phantom-update-run-${name.replace(/[^a-zA-Z0-9_.-]+/g, '-')}`,
      // Its own volume: this Mac may run the server stack too, whose volume
      // compose would refuse to share across projects.
      WORKSPACE_VOLUME: 'phantom-runner-workspaces',
    });
    console.log(`starting the runners "${name}" for ${url} (${IMAGE}:${tag}) — a session runner and a client runner`);
    const code = compose(['up', '-d']);
    if (code === 0) console.log('runners up — `phantom-cli runner status` shows what the backend sees, `phantom-cli runner logs` follows them');
    return code;
  }
  if (!existsSync(join(HOST_DIR, 'docker-compose.yml'))) { console.error('no runners on this machine — phantom-cli runner start'); return 1; }
  if (command === 'stop') return compose(['down']);
  if (command === 'logs') return compose(['logs', '-f', 'runner']);
  if (command === 'update') {
    // The backend does it: the runner pulls the images and its sidecar
    // recreates the stack (runners/docker-compose.yml). This machine's
    // runner is the one whose name .env holds.
    const tag = args[1] ?? await checkLatest();
    if (!tag) { console.error('could not reach GitHub to find the latest release — name one: phantom-cli runner update vX.Y.Z'); return 1; }
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) { console.error(`not a release tag: ${tag} (vX.Y.Z)`); return 1; }
    const name = envValue('HOST_NAME') ?? hostname();
    const server = { url, call: apiFor(url, key, savedCaFor(url)), stream: streamFor(url, key, savedCaFor(url)) };
    // A stale row may share the name (a runner started afresh on a new
    // volume): the online one is this machine's.
    const mine = (await listRunners(server)).filter((runner) => runner.name === name).sort((a, b) => Number(b.online) - Number(a.online))[0];
    if (!mine) { console.error(`the backend knows no runner named "${name}" — is it up? phantom-cli runner status`); return 1; }
    if (!mine.online) { console.error(`"${name}" is offline — the backend cannot reach it; phantom-cli runner logs`); return 1; }
    if (mine.version === tag) { console.log(`"${name}" is on ${bare(tag)} already.`); return 0; }
    const tty = process.stdout.isTTY;
    return updateRunners({
      appVersion: APP_VERSION, latest: async () => tag, server, installClient: async () => undefined, confirm: async () => true,
      out: (line) => process.stdout.write(`${tty ? '\r\x1b[K' : ''}${line}\n`),
      ...(tty ? { tick: (line: string) => process.stdout.write(`\r${line.slice(0, Math.max(1, (process.stdout.columns || 80) - 1))}\x1b[K`) } : {}),
      sleep: (milliseconds) => new Promise((wake) => setTimeout(wake, milliseconds)), now: Date.now,
    }, server, tag, mine.id);
  }
  if (command === 'status') {
    compose(['ps']);
    try {
      const listed = await apiFor(url, key, savedCaFor(url))('GET', '/runners') as { hosts: Array<{ id: string; name: string; online: boolean; ownerUserId: string | null; workspaces: number; connectedAt: string | null; version: string | null; sessions: boolean; clients: boolean; load: { cpu: number; freeGB: number; usedPct: number; running: number } | null }> };
      if (!listed.hosts.length) { console.log('the backend knows no runners'); return 0; }
      console.log('\nthe backend sees:');
      for (const host of listed.hosts) {
        const load = host.load ? `  cpu ${host.load.cpu.toFixed(2)}  ${host.load.running} running  ${Math.round(host.load.freeGB)} GB free` : '';
        const runs = [host.sessions ? 'sessions' : '', host.clients ? 'clients' : ''].filter(Boolean).join('+');
        console.log(`  ${host.online ? '●' : '○'} ${host.name}  ${host.version ? bare(host.version) : '?'}  ${host.ownerUserId ? 'user' : 'shared'} ${runs} runner  ${host.sessions ? `${host.workspaces} workspace${host.workspaces === 1 ? '' : 's'}` : ''}${load}  ${host.online ? 'online' : `offline${host.connectedAt ? ` (last ${host.connectedAt})` : ''}`}  ${host.id}`);
      }
    } catch (error) { console.error(`could not ask the backend: ${(error as Error).message}`); return 1; }
    return 0;
  }
  return usage();
}
