// Provisioning a phantom-backend server over SSH — the engine under the
// setup-backend wizard (setup.ts). ssh owns the terminal for the install
// (stdio inherited): its host-key and password prompts are its own, our code
// never sees, holds, or stores a password. One connection master serves the
// whole run, so the password is typed once.
//
// The box FETCHES the install script — from this cli's release tag, so script
// version = cli version — because ssh's stdin has to stay free for the
// password prompt; a rig carries this checkout's copy inline instead
// (`script`) and points PHANTOM_BACKEND_API_IMAGE at a locally built image. The
// host files the script unpacks still come out of the api IMAGE — this only
// decides which script drives the unpacking.
//
// Everything spawned goes through an injectable runner so the whole flow is
// unit-testable without a network; the default runner is `ssh` from PATH,
// which brings ~/.ssh/config, the agent, ProxyJump and known_hosts for free.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { CONFIG_DIR } from './config.js';
import { APP_VERSION, REPO, parseVersion } from './selfUpdate.js';

/** Where an internal-mode server's root certificate lives on this machine,
 *  by host. setup saves it; index.tsx wires it into the app's fetch at launch. */
export const caPathFor = (host: string, dir = CONFIG_DIR): string => join(dir, 'ca', `${host}.pem`);

/** The saved CA for a server URL, when the host has one. */
export function savedCaFor(url: string, dir = CONFIG_DIR): string | undefined {
  try {
    const path = caPathFor(new URL(url).hostname, dir);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  } catch { return undefined; }
}

export interface Target { user: string; host: string; port?: number }

/** `root@1.2.3.4`, `user@host:2222`, or a bare host (user defaults to root —
 *  a blank VPS is what this flow is for). Returns an error string instead of
 *  throwing so the form can show it. */
export function parseTarget(s: string): Target | { error: string } {
  const clean = s.trim();
  if (!clean) return { error: 'where should the server go? user@host, e.g. root@203.0.113.7' };
  const at = clean.lastIndexOf('@');
  const user = at > 0 ? clean.slice(0, at) : 'root';
  let host = at > 0 ? clean.slice(at + 1) : clean;
  let port: number | undefined;
  // host:port — but leave IPv6 literals ([::1]:22 unsupported, name it) alone.
  const colon = host.lastIndexOf(':');
  if (colon >= 0 && host.indexOf(':') === colon) {
    const p = Number(host.slice(colon + 1));
    if (!Number.isInteger(p) || p < 1 || p > 65535) return { error: `not a port: ${host.slice(colon + 1)}` };
    port = p;
    host = host.slice(0, colon);
  } else if (colon >= 0) {
    return { error: 'IPv6 targets are not supported yet — use a name or IPv4 address' };
  }
  if (!/^[A-Za-z0-9._-]+$/.test(host)) return { error: `not a host: ${host}` };
  if (!/^[A-Za-z0-9._-]+$/.test(user)) return { error: `not a user: ${user}` };
  return { user, host, port };
}

/** What a runner does: spawn ssh with these args, feed it stdin, stream every
 *  output chunk to onData, resolve with the exit code and captured output.
 *  Injectable so tests never touch a network. */
export type SshRun = (args: string[], opts: { stdin?: string; onData?: (chunk: string) => void; tty?: boolean })
  => Promise<{ code: number; out: string }>;

/** `tty`: ssh gets the whole terminal (stdio inherited) — its host-key and
 *  password prompts, the installer's stream, ctrl-c, all its own; nothing is
 *  captured. Otherwise output is captured and stdin is the script (or
 *  closed). Our own process must not be reading the terminal while ssh
 *  runs: node keeps consuming tty input once anything has read stdin, even
 *  paused — setup.ts's asker opens /dev/tty per question for that reason. */
export const sshRun: SshRun = (args, { stdin, onData, tty }) =>
  new Promise((resolvePromise, reject) => {
    mkdirSync(SSH_CONTROL_DIR, { recursive: true, mode: 0o700 });
    if (tty) {
      const child = spawn('ssh', args, { stdio: 'inherit' });
      child.on('error', (e) => reject(new Error(`could not run ssh: ${e.message}`)));
      child.on('close', (code) => resolvePromise({ code: code ?? 1, out: '' }));
      return;
    }
    const child = spawn('ssh', args, { stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let out = '';
    const take = (chunk: Buffer) => { const s = chunk.toString('utf8'); out += s; onData?.(s); };
    child.stdout!.on('data', take);
    child.stderr!.on('data', take);
    child.on('error', (e) => reject(new Error(`could not run ssh: ${e.message}`)));
    child.on('close', (code) => resolvePromise({ code: code ?? 1, out }));
    if (stdin !== undefined) child.stdin!.end(stdin);
  });

export interface SshOpts { acceptNew?: boolean; identity?: string; run?: SshRun }

/** One password for the whole wizard: the first ssh becomes a master that
 *  lingers (ControlPersist) and the pairing read-back and the CA fetch ride
 *  it. Unix socket paths cap near 104 bytes and ssh appends a 17-byte random
 *  suffix while binding, so the path must be SHORT and independent of the
 *  home directory (a repo checkout's .phantom-cli was too long): a per-user
 *  dir under /tmp, mode 0700. %C is ssh's hash of host+port+user (40). */
export const SSH_CONTROL_DIR = `/tmp/phantom-cli-ssh-${process.getuid?.() ?? 'u'}`;
export const SSH_CONTROL_PATH = join(SSH_CONTROL_DIR, '%C');

/** ssh argv for a target: options, port, destination, then the remote command.
 *  StrictHostKeyChecking is never disabled; `acceptNew` (rigs, tests) maps to
 *  accept-new — first contact records the key, a CHANGED key still refuses.
 *  `identity` (rigs) is a keyfile; without it ssh's own config/agent decide.
 *  `tty` asks for a remote pty so ctrl-c reaches the installer. */
export function sshArgs(t: Target, command: string, opts: SshOpts & { tty?: boolean } = {}): string[] {
  return [
    '-o', 'ConnectTimeout=15',
    '-o', 'ControlMaster=auto', '-o', `ControlPath=${SSH_CONTROL_PATH}`, '-o', 'ControlPersist=300',
    ...(opts.acceptNew ? ['-o', 'StrictHostKeyChecking=accept-new'] : []),
    ...(opts.identity ? ['-i', opts.identity] : []),
    ...(t.port ? ['-p', String(t.port)] : []),
    ...(opts.tty ? ['-t'] : []),
    `${t.user}@${t.host}`,
    '--',
    command,
  ];
}

/** Tear the lingering master down once the wizard is done. Best effort. */
export async function closeSshMaster(t: Target, opts: SshOpts = {}): Promise<void> {
  const run = opts.run ?? sshRun;
  const args = ['-O', 'exit', '-o', `ControlPath=${SSH_CONTROL_PATH}`,
    ...(t.port ? ['-p', String(t.port)] : []), `${t.user}@${t.host}`];
  try { await run(args, {}); } catch { /* no master, nothing to close */ }
}

/** Where the box downloads the server installer from: the release matching
 *  THIS cli (script version = cli version); a checkout ('dev') reads main. */
export function installScriptUrl(version = APP_VERSION, repo = REPO): string {
  const ref = parseVersion(version) ? `v${version.replace(/^v/, '')}` : 'main';
  return `https://raw.githubusercontent.com/${repo}/${ref}/scripts/install.sh`;
}

// A remote value we compose into a shell line. Everything we pass is a flag,
// an image name, a directory or a tag — this refuses anything shell-active
// rather than trying to quote it.
const SAFE = /^[A-Za-z0-9._\/:@=,-]+$/;
function safe(kind: string, v: string): string {
  if (!SAFE.test(v)) throw new Error(`${kind} contains characters that cannot ride a shell line: ${v}`);
  return v;
}

export interface InstallOptions extends SshOpts {
  /** Extra installer flags, e.g. ['--tls=internal', '--address=localhost']. */
  flags?: string[];
  /** Env overrides for the script (PHANTOM_BACKEND_API_IMAGE, PHANTOM_BACKEND_DIR — the
   *  script's own test hooks), prefixed onto the remote command. */
  env?: Record<string, string>;
  onData?: (chunk: string) => void;
  /** Where the box downloads install.sh from; defaults to this cli's release. */
  scriptUrl?: string;
  /** The rig/test seam: a script TEXT, carried inline on the command line
   *  instead of downloaded — the rig installs THIS checkout's install.sh. */
  script?: string;
  /** Hand ssh the terminal (the wizard); off = captured output (rig, tests). */
  tty?: boolean;
}

export const INSTALL_SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/install.sh');

/** Run the server installer on the box. `--yes` always: every question the
 *  installer could ask is a default the wizard already chose; re-running is
 *  the installer's own documented update/recovery path, so this is safe
 *  against a box that already has one. The script never rides ssh's stdin —
 *  that has to stay free for the password prompt — the box fetches it
 *  (curl, else wget), or it arrives base64 on the command line. */
export async function runInstall(t: Target, opts: InstallOptions = {}): Promise<void> {
  const run = opts.run ?? sshRun;
  const envPrefix = Object.entries(opts.env ?? {})
    .map(([k, v]) => `${safe('env name', k)}=${safe(k, v)}`).join(' ');
  const flags = (opts.flags ?? []).map((f) => safe('flag', f)).join(' ');
  const fetch = opts.script !== undefined
    ? `echo ${Buffer.from(opts.script, 'utf8').toString('base64')} | base64 -d`
    : (() => { const u = safe('url', opts.scriptUrl ?? installScriptUrl());
      return `sh -c 'if command -v curl >/dev/null 2>&1; then curl -fsSL ${u}; else wget -qO- ${u}; fi'`; })();
  const command = `${fetch} | ${envPrefix ? `${envPrefix} ` : ''}sh -s -- --yes${flags ? ` ${flags}` : ''}`;
  const { code } = await run(sshArgs(t, command, { ...opts, tty: opts.tty }), { onData: opts.onData, tty: opts.tty });
  if (code !== 0) throw new Error(`the installer exited with code ${code} — its output above says where it stopped`);
}

export interface ServerFacts { address: string; port: number; tls: string; key: string }

// One remote line that reads the four facts out of the install's .env and
// prints them tagged, one per line — no JSON building in shell. sudo only
// when not root, exactly as the installer itself decides.
const FACTS_CMD = [
  'S=""; [ "$(id -u)" -ne 0 ] && S=sudo;',
  '$S sh -c \'for k in PHANTOM_BACKEND_ADDRESS PHANTOM_BACKEND_PORT PHANTOM_BACKEND_TLS API_KEY;',
  'do printf "PHANTOM_FACT %s=%s\\n" "$k" "$(grep "^$k=" "${PHANTOM_BACKEND_DIR:-/opt/phantom-looper}/.env" | head -1 | cut -d= -f2-)"; done\'',
].join(' ');

/** Read back what the installer wrote: the address the certificate was issued
 *  for (the URL must be that exact string), the TLS mode, and the API key.
 *  The key crosses only the encrypted ssh channel — never an argv, never a
 *  shell history line. */
export async function readServerFacts(t: Target, opts: SshOpts = {}): Promise<ServerFacts> {
  const run = opts.run ?? sshRun;
  const { code, out } = await run(sshArgs(t, FACTS_CMD, opts), {});
  if (code !== 0) throw new Error(`could not read the server's configuration (ssh exited ${code})`);
  const facts: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const m = /^PHANTOM_FACT ([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) facts[m[1]] = m[2];
  }
  const address = facts.PHANTOM_BACKEND_ADDRESS ?? '';
  const key = facts.API_KEY ?? '';
  if (!address || !key) throw new Error('the box answered, but /opt/phantom-looper/.env has no address or API key — did the install finish?');
  return { address, port: Number(facts.PHANTOM_BACKEND_PORT || 8080), tls: facts.PHANTOM_BACKEND_TLS || 'public', key };
}

/** In internal-TLS mode, the one root certificate clients must trust —
 *  `phantom-backend ca` on the box prints it. */
export async function readServerCa(t: Target, opts: SshOpts = {}): Promise<string> {
  const run = opts.run ?? sshRun;
  const cmd = 'S=""; [ "$(id -u)" -ne 0 ] && S=sudo; $S phantom-backend ca';
  const { code, out } = await run(sshArgs(t, cmd, opts), {});
  const pem = out.slice(out.indexOf('-----BEGIN'));
  if (code !== 0 || !pem.includes('-----BEGIN CERTIFICATE-----')) {
    throw new Error('could not read the server\'s root certificate (phantom-backend ca)');
  }
  return pem;
}

/** A minimal envelope client on node http(s), for the moments global fetch
 *  cannot serve: a CA to pin before the app's dispatcher is wired (setup), a
 *  route to call before the app renders (update --server). Generic
 *  method+path — the /settings route names live in settings.ts. */
export function apiFor(base: string, key: string, ca?: string) {
  return (method: string, path: string, body?: unknown) =>
    new Promise<unknown>((resolvePromise, reject) => {
      const u = new URL(path, base);
      const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(u, {
        method,
        headers: {
          authorization: `Bearer ${key}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        timeout: 15_000,
        ...(ca ? { ca } : {}),
      }, (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(text) as { ok: boolean; data?: unknown; error?: { message?: string; code?: string } };
            // The status rides on the error: a 401 means the server answered
            // and refused the key, which is a different fix from "nothing there".
            if (!j.ok) return reject(Object.assign(new Error(j.error?.message ?? j.error?.code ?? `${method} ${path}: HTTP ${res.statusCode}`), { status: res.statusCode }));
            resolvePromise(j.data ?? j);   // /health answers flat, without a data envelope
          } catch { reject(Object.assign(new Error(`${method} ${path}: HTTP ${res.statusCode}`), { status: res.statusCode })); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
}

/** Verify the pairing FROM THIS MACHINE — the path the app will actually use.
 *  The installer's own checks run on the box and cannot speak for the route
 *  from here (cloud firewalls, NAT). Plain node http(s) rather than fetch so
 *  an internal-mode CA can be pinned for this one probe without touching the
 *  process's trust store. */
export function verifyFromHere(url: string, key: string, ca?: string, timeoutMs = 10_000):
  Promise<{ ok: true; version: string } | { ok: false; reason: string }> {
  return new Promise((resolvePromise) => {
    let u: URL;
    try { u = new URL(url); } catch { return resolvePromise({ ok: false, reason: `not a URL: ${url}` }); }
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      new URL('/health', u),
      { headers: { authorization: `Bearer ${key}` }, timeout: timeoutMs, ...(ca ? { ca } : {}) },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolvePromise({ ok: false, reason: `GET ${u.origin}/health answered ${res.statusCode}` });
          try {
            // /health answers flat ({ok, version}), unlike the enveloped routes.
            const j = JSON.parse(body) as { version?: string; data?: { version?: string } };
            resolvePromise({ ok: true, version: j.version ?? j.data?.version ?? 'unknown' });
          } catch { resolvePromise({ ok: false, reason: 'the server answered, but not with phantom-backend\'s health shape' }); }
        });
      },
    );
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolvePromise({ ok: false, reason: e.message }));
    req.end();
  });
}
