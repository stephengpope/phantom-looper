// Provisioning a phantom-backend server over SSH — the engine under the
// setup-backend wizard (setup.tsx). No Ink in here: provisioning happens OUTSIDE
// the alternate screen, streaming the installer's own output, because ssh must
// own the tty for its password and host-key prompts. Our code never sees,
// holds, or stores an SSH password — ssh itself asks on /dev/tty, which works
// even though stdin is the piped install script.
//
// The install script is OURS, piped over stdin (`ssh host 'sh -s -- --yes'`
// < scripts/install.sh): the box never fetches it from GitHub, the script
// version always matches this cli's release, and a test rig can point
// PHANTOM_BACKEND_IMAGE at a locally built image. The host files the script
// unpacks still come out of the api IMAGE — this only decides which script
// drives the unpacking.
//
// Everything spawned goes through an injectable runner so the whole flow is
// unit-testable without a network; the default runner is `ssh` from PATH,
// which brings ~/.ssh/config, the agent, ProxyJump and known_hosts for free.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { join, resolve } from 'node:path';
import { CONFIG_DIR } from './config.js';

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
export type SshRun = (args: string[], opts: { stdin?: string; onData?: (chunk: string) => void })
  => Promise<{ code: number; out: string }>;

export const sshRun: SshRun = (args, { stdin, onData }) =>
  new Promise((resolvePromise, reject) => {
    // stdin is a pipe (the script rides it); ssh's password and host-key
    // prompts go to /dev/tty directly, so piping does not break them.
    const child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const take = (chunk: Buffer) => { const s = chunk.toString('utf8'); out += s; onData?.(s); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => reject(new Error(`could not run ssh: ${e.message}`)));
    child.on('close', (code) => resolvePromise({ code: code ?? 1, out }));
    if (stdin !== undefined) child.stdin.write(stdin);
    child.stdin.end();
  });

export interface SshOpts { acceptNew?: boolean; identity?: string; run?: SshRun }

/** ssh argv for a target: options, port, destination, then the remote command.
 *  StrictHostKeyChecking is never disabled; `acceptNew` (rigs, tests) maps to
 *  accept-new — first contact records the key, a CHANGED key still refuses.
 *  `identity` (rigs) is a keyfile; without it ssh's own config/agent decide. */
export function sshArgs(t: Target, command: string, opts: SshOpts = {}): string[] {
  return [
    '-o', 'ConnectTimeout=15',
    ...(opts.acceptNew ? ['-o', 'StrictHostKeyChecking=accept-new'] : []),
    ...(opts.identity ? ['-i', opts.identity] : []),
    ...(t.port ? ['-p', String(t.port)] : []),
    `${t.user}@${t.host}`,
    '--',
    command,
  ];
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
  /** Env overrides for the script (PHANTOM_BACKEND_IMAGE, PHANTOM_BACKEND_DIR — the
   *  script's own test hooks), prefixed onto the remote command. */
  env?: Record<string, string>;
  onData?: (chunk: string) => void;
  /** The script text; defaults to the scripts/install.sh shipped beside this cli. */
  script?: string;
}

export const INSTALL_SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/install.sh');

/** Run the server installer on the box, streaming its output. `--yes` always:
 *  every question the installer could ask is a default the wizard already
 *  chose; re-running is the installer's own documented update/recovery path,
 *  so this is safe against a box that already has one. */
export async function runInstall(t: Target, opts: InstallOptions = {}): Promise<void> {
  const run = opts.run ?? sshRun;
  const script = opts.script ?? readFileSync(INSTALL_SCRIPT_PATH, 'utf8');
  const envPrefix = Object.entries(opts.env ?? {})
    .map(([k, v]) => `${safe('env name', k)}=${safe(k, v)}`).join(' ');
  const flags = (opts.flags ?? []).map((f) => safe('flag', f)).join(' ');
  const command = `${envPrefix ? `${envPrefix} ` : ''}sh -s -- --yes${flags ? ` ${flags}` : ''}`;
  const { code } = await run(sshArgs(t, command, opts), { stdin: script, onData: opts.onData });
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
