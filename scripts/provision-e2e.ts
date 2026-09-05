// End-to-end provisioning against the local rig — the setup wizard's exact
// path (provision.ts), minus the questions: install over ssh with the repo's
// own install.sh carried inline (the wizard has the box download the release
// copy), read the pairing back, pull the internal root certificate, and
// verify https from THIS side, CA pinned. Prints PASS or dies where it broke.
//
//   ./scripts/provision-rig.sh                                      # once
//   npx tsx --tsconfig phantom-cli/tsconfig.json scripts/provision-e2e.ts
//
// Deliberately touches nothing under ~/.phantom-cli: this proves the path,
// pairing a real machine is the wizard's job.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  parseTarget, runInstall, readServerFacts, readServerCa, verifyFromHere, closeSshMaster, INSTALL_SCRIPT_PATH,
} from '../phantom-cli/provision.js';

const target = parseTarget(process.env.RIG_TARGET ?? 'root@localhost:2222');
if ('error' in target) throw new Error(target.error);
const ssh = { acceptNew: true, identity: process.env.PHANTOM_CLI_SSH_IDENTITY ?? '/tmp/phantom-rig/id_ed25519' };

const step = (s: string) => console.log(`\n=== ${s}\n`);

step('rig reachable?');
try {
  execFileSync('ssh', ['-o', 'ConnectTimeout=5', '-o', 'StrictHostKeyChecking=accept-new',
    '-i', ssh.identity, '-p', String(target.port ?? 22), `${target.user}@${target.host}`, 'true']);
} catch {
  throw new Error('the rig does not answer — boot it first: ./scripts/provision-rig.sh');
}

step('install.sh over ssh (this checkout\'s copy, inline, --yes)');
await runInstall(target, {
  ...ssh, script: readFileSync(INSTALL_SCRIPT_PATH, 'utf8'),
  flags: ['--tls=internal', '--address=localhost', '--no-firewall'],
  onData: (c) => process.stdout.write(c),
});

step('read the pairing back');
const facts = await readServerFacts(target, ssh);
console.log(`address=${facts.address} port=${facts.port} tls=${facts.tls} key=${facts.key.slice(0, 4)}…`);
if (facts.tls !== 'internal') throw new Error(`expected tls=internal, got ${facts.tls}`);
if (facts.address !== 'localhost') throw new Error(`expected address=localhost, got ${facts.address}`);

step('pull the root certificate (phantom-backend ca)');
const ca = await readServerCa(target, ssh);
console.log(`${ca.split('\n')[0]} (${ca.length} bytes)`);

step('verify from THIS machine: https://localhost, CA pinned, bearer key');
const v = await verifyFromHere(`https://${facts.address}`, facts.key, ca, 30_000);
if (!v.ok) throw new Error(`verify failed: ${v.reason}`);
console.log(`server version: ${v.version}`);
await closeSshMaster(target, ssh);

console.log('\nPASS — install, pairing read-back, CA trust and client-side verify all hold\n');
