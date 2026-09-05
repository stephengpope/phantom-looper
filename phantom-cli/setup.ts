// `phantom-cli setup-backend` — installs a phantom-backend server over ssh,
// pairs this machine with it, saves one model credential, exits. A server
// that already exists is paired from inside the app, on /server; this path
// is INSTALL only.
//
// A plain step-by-step script, no Ink: ssh has to own the terminal for its
// host-key and password prompts, and node keeps consuming terminal input
// once anything has read process.stdin — paused or not — so a screen that
// stays resident swallows the "yes" ssh is waiting for (the 2026-09-05
// hang). Every question here opens its OWN handle on /dev/tty and closes it
// (`ttyAsker`), so between questions nothing of ours is reading. The
// installer is fetched BY THE BOX (provision.ts), never piped over ssh's
// stdin, for the same reason; ssh's connection master means one password
// for the whole run.
//
// Two questions end to end: where the server goes, and one model credential.
// Every server-side question is a default passed as --yes; re-running against
// the same box is the installer's own documented update/recovery path.
import * as clack from '@clack/prompts';
import { chmodSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ReadStream } from 'node:tty';
import {
  apiFor, parseTarget, runInstall, readServerFacts, readServerCa, verifyFromHere, closeSshMaster,
  installScriptUrl, caPathFor, type SshOpts, type SshRun, type Target,
} from './provision.js';
import { setLocal } from './local.js';
import { makeSettings } from './settings.js';
import { PROVIDERS, PROVIDER_KEY } from './config.js';

/** The questions, as an interface: the wizard asks through it, tests script
 *  it. `undefined` is the person backing out (esc / ctrl-c). */
export interface Asker {
  text(message: string, validate?: (v: string) => string | undefined): Promise<string | undefined>;
  select(message: string, options: { value: string; label: string; hint?: string }[]): Promise<string | undefined>;
  password(message: string): Promise<string | undefined>;
}

/** One question, one private terminal handle, closed after. */
async function onTty<T>(fn: (input: ReadStream) => Promise<T | symbol>): Promise<T | undefined> {
  let fd: number;
  try { fd = openSync('/dev/tty', 'r+'); } catch { throw new Error('setup-backend needs a terminal'); }
  const input = new ReadStream(fd);
  try {
    const v = await fn(input);
    return clack.isCancel(v) ? undefined : v as T;
  } finally { input.destroy(); }
}

export const ttyAsker: Asker = {
  text: (message, validate) => onTty((input) => clack.text({ message, input, validate: validate ? (v) => validate(v ?? '') : undefined })),
  select: (message, options) => onTty((input) => clack.select({ message, input, options })),
  password: (message) => onTty((input) => clack.password({ message, input })),
};

interface Paired { url: string; key: string; ca?: string }

function savePairing(p: Paired, configPath?: string): void {
  if (p.ca) {
    const path = caPathFor(new URL(p.url).hostname);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, p.ca, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  const bad = setLocal('server_url', p.url, configPath) ?? setLocal('server_key', p.key, configPath);
  if (bad) throw new Error(bad);
}

export interface SetupDeps {
  run?: SshRun; acceptNew?: boolean; identity?: string;
  ask?: Asker;
  verify?: typeof verifyFromHere;
  api?: typeof apiFor;
  exit?: (code: number) => never;
  /** The local settings file the pairing lands in (tests). */
  configPath?: string;
}

/** The whole setup-backend flow. Resolves once this machine is paired
 *  (local settings written) and the model key is saved or skipped; exits
 *  when the person backs out, or when the pairing is saved but the server
 *  is not yet reachable from here — with the reason and the fix on screen. */
export async function runSetup(deps: SetupDeps = {}): Promise<void> {
  const ask = deps.ask ?? ttyAsker;
  const verify = deps.verify ?? verifyFromHere;
  const api = deps.api ?? apiFor;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const sshOpts: SshOpts = {
    run: deps.run,
    acceptNew: deps.acceptNew ?? Boolean(process.env.PHANTOM_CLI_SSH_ACCEPT_NEW),
    identity: deps.identity ?? process.env.PHANTOM_CLI_SSH_IDENTITY,
  };
  // Rig hooks ride the environment, never the UI.
  const env: Record<string, string> = {};
  for (const k of ['PHANTOM_BACKEND_IMAGE', 'PHANTOM_BACKEND_FS_IMAGE', 'PHANTOM_BACKEND_DIR'] as const) {
    if (process.env[k]) env[k] = process.env[k];
  }
  const flags = (process.env.PHANTOM_CLI_INSTALL_FLAGS ?? '').split(' ').filter(Boolean);

  clack.intro('phantom-looper · set up a server');
  clack.log.info([
    'a fresh Ubuntu/Debian box you can ssh into — root recommended.',
    'prefer to do it yourself? on the box, run:',
    `  curl -fsSL ${installScriptUrl()} | sh`,
    'then put the address and key it prints under /server in the app.',
  ].join('\n'));

  let target: Target | undefined;
  let paired: Paired | undefined;
  while (!paired) {
    const answer = await ask.text('where does the server go? (user@host or user@host:port)', (v) => {
      const t = parseTarget(v);
      return 'error' in t ? t.error : undefined;
    });
    if (answer === undefined) { clack.cancel('nothing set up — run `phantom-cli setup-backend` any time'); return exit(0); }
    const t = parseTarget(answer);
    if ('error' in t) continue;   // validate already refused it; belt and braces
    target = t;
    clack.log.step(`installing on ${target.user}@${target.host}${target.port ? `:${target.port}` : ''} — ssh has the terminal now: it may ask for the host fingerprint and your password, once`);
    try {
      await runInstall(target, { ...sshOpts, env, flags, tty: true });
      const facts = await readServerFacts(target, sshOpts);
      paired = { url: `https://${facts.address}`, key: facts.key };
      if (facts.tls === 'internal') paired.ca = await readServerCa(target, sshOpts);
      savePairing(paired, deps.configPath);
    } catch (e) {
      clack.log.error((e as Error).message);
      paired = undefined;
      continue;
    }
  }
  // Verify FROM HERE — the path the app will actually use. The box's own
  // checks cannot speak for it (cloud firewalls, NAT).
  const v = await verify(paired.url, paired.key, paired.ca);
  if (v.ok) {
    clack.log.success(`paired with ${paired.url} (server ${v.version})`);
  } else {
    clack.log.success(`pairing saved: ${paired.url}`);
    clack.log.warn(`but it does not answer from this machine yet: ${v.reason}\nusually the cloud firewall — open ports 80 and 443 to the box, then run phantom-cli.`);
    if (target) await closeSshMaster(target, sshOpts);
    return exit(0);
  }

  // One model credential, into the server's encrypted store — the same row
  // /keys edits later. Skippable; the first turn's error points at /keys.
  const settings = makeSettings(api(paired.url, paired.key, paired.ca));
  for (;;) {
    const provider = await ask.select('model access — one credential, stored encrypted on the server', [
      { value: 'anthropic', label: 'anthropic', hint: 'API key or Claude subscription token' },
      ...PROVIDERS.filter((p) => p !== 'anthropic').map((p) => ({ value: p as string, label: p as string })),
      { value: '', label: 'skip for now', hint: 'paste one later on /keys' },
    ]);
    if (!provider) break;
    const key = await ask.password(`${provider} — paste the key`);
    if (!key?.trim()) continue;
    try {
      await settings.patch({ [PROVIDER_KEY[provider as keyof typeof PROVIDER_KEY]]: key.trim(), provider });
      clack.log.success(`${provider} key saved on the server`);
      break;
    } catch (e) {
      clack.log.error((e as Error).message);
    }
  }
  if (target) await closeSshMaster(target, sshOpts);
  clack.outro('done — run phantom-cli');
}
