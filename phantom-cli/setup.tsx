// `phantom-cli setup-backend` — the driver. Installs a phantom-backend server
// over ssh, pairs this machine with it, saves one model credential, exits.
// A server that already exists is paired from inside the app, on /server;
// this path is INSTALL only.
//
// The shape is index.tsx's own startup pattern (Launcher, NewWorkspace): each
// screen renders standalone, answers once, unmounts — and the work happens
// BETWEEN screens, in plain console output. Provisioning especially: ssh owns
// the tty for its password and host-key prompts (our code never sees a
// password), and the installer's stream is the progress display.
//
// Two questions end to end: where the server goes, and one model credential.
// Every server-side question is a default passed as --yes; re-running against
// the same box is the installer's own documented update/recovery path.
import { render } from 'ink';
import type { ReactElement } from 'react';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  apiFor, parseTarget, runInstall, readServerFacts, readServerCa, verifyFromHere,
  caPathFor, type SshOpts, type SshRun, type Target,
} from './provision.js';
import { setLocal } from './local.js';
import { makeSettings } from './settings.js';
import { SetupTarget, SetupProviderKey, type ProviderKeyAnswer } from './components/Setup.js';

const say = (s: string) => process.stdout.write(`${s}\n`);

/** Render one screen, resolve with its answer; esc/cancel resolves undefined. */
async function ask<T>(element: (done: (v: T | undefined) => void) => ReactElement): Promise<T | undefined> {
  let result: T | undefined;
  const ui = render(element((v) => { result = v; ui.unmount(); }), { exitOnCtrlC: true });
  await ui.waitUntilExit();
  return result;
}

interface Paired { url: string; key: string; ca?: string }

/** Install over SSH and read the pairing back. Streams the installer.
 *  Throws with the reason on any failure — the caller re-shows the form. */
async function provisionOverSsh(target: Target, opts: SshOpts): Promise<Paired> {
  // Test hooks ride the environment, never the UI: the rig points
  // PHANTOM_BACKEND_IMAGE at a locally built image and adds installer flags.
  const env: Record<string, string> = {};
  for (const k of ['PHANTOM_BACKEND_IMAGE', 'PHANTOM_BACKEND_FS_IMAGE', 'PHANTOM_BACKEND_DIR'] as const) {
    if (process.env[k]) env[k] = process.env[k];
  }
  const flags = (process.env.PHANTOM_CLI_INSTALL_FLAGS ?? '').split(' ').filter(Boolean);
  say('');
  say(`→ installing phantom-backend on ${target.user}@${target.host}${target.port ? `:${target.port}` : ''} — ssh may ask for a password or a host fingerprint`);
  say('');
  await runInstall(target, { ...opts, env, flags, onData: (c) => process.stdout.write(c) });
  const facts = await readServerFacts(target, opts);
  const paired: Paired = { url: `https://${facts.address}`, key: facts.key };
  if (facts.tls === 'internal') paired.ca = await readServerCa(target, opts);
  return paired;
}

function savePairing(p: Paired): void {
  if (p.ca) {
    const path = caPathFor(new URL(p.url).hostname);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, p.ca, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  const bad = setLocal('server_url', p.url) ?? setLocal('server_key', p.key);
  if (bad) throw new Error(bad);
}

export interface SetupDeps { run?: SshRun; acceptNew?: boolean; identity?: string }

/** The whole setup-backend flow. Resolves once this machine is paired
 *  (local settings written) and the model key is saved or skipped; exits the
 *  process when the user backs out, or when the pairing is saved but the
 *  server is not yet reachable from here — with the reason and the fix on
 *  screen. */
export async function runSetup(deps: SetupDeps = {}): Promise<void> {
  const sshOpts = {
    run: deps.run,
    acceptNew: deps.acceptNew ?? Boolean(process.env.PHANTOM_CLI_SSH_ACCEPT_NEW),
    identity: deps.identity ?? process.env.PHANTOM_CLI_SSH_IDENTITY,
  };
  let paired: Paired | undefined;
  let error: string | undefined;

  while (!paired) {
    const targetStr = await ask<string>((done) => (
      <SetupTarget error={error} onSubmit={done} onCancel={() => done(undefined)} />
    ));
    if (!targetStr) { say('nothing set up — run `phantom-cli setup-backend` any time'); process.exit(0); }
    const target = parseTarget(targetStr);
    if ('error' in target) { error = target.error; continue; }
    try {
      paired = await provisionOverSsh(target, sshOpts);
      savePairing(paired);
    } catch (e) {
      error = (e as Error).message;
      continue;
    }
    // Verify FROM HERE — the path the app will actually use. The box's own
    // checks cannot speak for it (cloud firewalls, NAT).
    const v = await verifyFromHere(paired.url, paired.key, paired.ca);
    if (v.ok) {
      say('');
      say(`✓ paired with ${paired.url} (server ${v.version})`);
    } else {
      say('');
      say(`✓ pairing saved: ${paired.url}`);
      say(`✗ but it does not answer from this machine yet: ${v.reason}`);
      say('  Usually the cloud firewall — open ports 80 and 443 to the box, then run phantom-cli.');
      process.exit(0);
    }
  }

  // One model credential, into the server's encrypted store — the same row
  // /keys edits later. Skippable; the first turn's error points at /keys.
  const settings = makeSettings(apiFor(paired.url, paired.key, paired.ca));
  let keyError: string | undefined;
  for (;;) {
    const answer = await ask<ProviderKeyAnswer | 'skip'>((done) => (
      <SetupProviderKey error={keyError}
        onSubmit={(v) => done(v)} onSkip={() => done('skip')} />
    ));
    if (!answer || answer === 'skip') break;
    try {
      await settings.patch({ [answer.settingKey]: answer.value, provider: answer.provider });
      say(`✓ ${answer.provider} key saved on the server`);
      break;
    } catch (e) {
      keyError = (e as Error).message;
    }
  }
  say('');
  say('done — run phantom-cli');
  say('');
}
