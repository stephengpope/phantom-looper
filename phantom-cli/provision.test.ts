// The provisioning engine, without a network: targets, the ssh argv, the
// remote command line, and the facts read-back — everything through the
// injectable runner. The real ssh path is exercised by the rig
// (scripts/provision-e2e.ts), not here.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTarget, sshArgs, runInstall, readServerFacts, readServerCa,
  caPathFor, savedCaFor, type SshRun, type Target,
} from './provision.js';

const T: Target = { user: 'root', host: 'example.com' };

test('parseTarget: user@host, ports, bare hosts, junk', () => {
  assert.deepEqual(parseTarget('root@1.2.3.4'), { user: 'root', host: '1.2.3.4', port: undefined });
  assert.deepEqual(parseTarget('deploy@box.example.com:2222'), { user: 'deploy', host: 'box.example.com', port: 2222 });
  // a bare host defaults to root — a blank VPS is what this flow is for
  assert.deepEqual(parseTarget('203.0.113.7'), { user: 'root', host: '203.0.113.7', port: undefined });
  assert.ok('error' in parseTarget(''));
  assert.ok('error' in parseTarget('root@host:notaport'));
  assert.ok('error' in parseTarget('root@host:99999'));
  assert.ok('error' in parseTarget('root@::1'));            // IPv6 named, not mangled
  assert.ok('error' in parseTarget('root@host;rm -rf /'));  // nothing shell-active
});

test('sshArgs: never disables host-key checking; accept-new only when asked', () => {
  const plain = sshArgs(T, 'true');
  assert.ok(!plain.join(' ').includes('StrictHostKeyChecking'));
  const rig = sshArgs(T, 'true', { acceptNew: true });
  assert.ok(rig.join(' ').includes('StrictHostKeyChecking=accept-new'));
  assert.ok(!rig.join(' ').includes('StrictHostKeyChecking=no'));
  const port = sshArgs({ ...T, port: 2222 }, 'true');
  assert.deepEqual(port.slice(port.indexOf('-p'), port.indexOf('-p') + 2), ['-p', '2222']);
  assert.equal(plain.at(-1), 'true');
  assert.equal(plain.at(-3), 'root@example.com');
});

function fake(result: { code: number; out: string }) {
  const calls: { args: string[]; stdin?: string }[] = [];
  const run: SshRun = async (args, { stdin, onData }) => {
    calls.push({ args, stdin });
    onData?.(result.out);
    return result;
  };
  return { calls, run };
}

test('runInstall: pipes OUR script over stdin, --yes always, env and flags on the line', async () => {
  const { calls, run } = fake({ code: 0, out: 'done' });
  await runInstall(T, {
    run, script: '#!/bin/sh\necho hi\n',
    env: { PHANTOM_BACKEND_IMAGE: 'localhost/api:test' },
    flags: ['--tls=internal', '--address=localhost'],
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].stdin, '#!/bin/sh\necho hi\n');
  const cmd = calls[0].args.at(-1)!;
  assert.equal(cmd, "PHANTOM_BACKEND_IMAGE=localhost/api:test sh -s -- --yes --tls=internal --address=localhost");
});

test('runInstall: a shell-active env value or flag is refused, never quoted around', async () => {
  const { run } = fake({ code: 0, out: '' });
  await assert.rejects(
    () => runInstall(T, { run, script: 'x', env: { PHANTOM_BACKEND_IMAGE: 'img; rm -rf /' } }),
    /cannot ride a shell line/);
  await assert.rejects(
    () => runInstall(T, { run, script: 'x', flags: ['--address=$(curl evil)'] }),
    /cannot ride a shell line/);
});

test('runInstall: a nonzero exit is an error that names the code', async () => {
  const { run } = fake({ code: 3, out: 'boom' });
  await assert.rejects(() => runInstall(T, { run, script: 'x' }), /exited with code 3/);
});

test('readServerFacts: parses the tagged lines and ignores everything else', async () => {
  const { run } = fake({
    code: 0,
    out: [
      'Warning: Permanently added ...',
      'PHANTOM_FACT PHANTOM_BACKEND_ADDRESS=203.0.113.7',
      'PHANTOM_FACT PHANTOM_BACKEND_PORT=8080',
      'PHANTOM_FACT PHANTOM_BACKEND_TLS=internal',
      'PHANTOM_FACT API_KEY=abc123',
    ].join('\n'),
  });
  const facts = await readServerFacts(T, { run });
  assert.deepEqual(facts, { address: '203.0.113.7', port: 8080, tls: 'internal', key: 'abc123' });
});

test('readServerFacts: an empty .env is a real message, not a bad pairing', async () => {
  const { run } = fake({ code: 0, out: 'PHANTOM_FACT PHANTOM_BACKEND_ADDRESS=\nPHANTOM_FACT API_KEY=\n' });
  await assert.rejects(() => readServerFacts(T, { run }), /did the install finish/);
});

test('readServerCa: returns the PEM, refuses ssh noise without one', async () => {
  const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n';
  const { run } = fake({ code: 0, out: `Warning: banner\n${pem}` });
  assert.equal(await readServerCa(T, { run }), pem);
  const { run: bad } = fake({ code: 0, out: 'no cert here' });
  await assert.rejects(() => readServerCa(T, { run: bad }), /root certificate/);
});

test('caPathFor/savedCaFor: by host, under the config dir', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const dir = mkdtempSync('/tmp/phantom-ca-');
  assert.equal(caPathFor('h.example', dir), join(dir, 'ca', 'h.example.pem'));
  assert.equal(savedCaFor('https://h.example', dir), undefined);
  mkdirSync(dirname(caPathFor('h.example', dir)), { recursive: true });
  writeFileSync(caPathFor('h.example', dir), 'PEM');
  assert.equal(savedCaFor('https://h.example', dir), 'PEM');
  assert.equal(savedCaFor('https://other.example', dir), undefined);
  assert.equal(savedCaFor('not a url', dir), undefined);
});
