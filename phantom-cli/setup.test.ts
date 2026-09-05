// The setup-backend flow with every edge scripted: the questions (Asker), ssh
// (SshRun), the client-side verify and the server api. What is pinned: the
// order of the steps, that the install hands ssh the terminal and never
// pipes the script over stdin, that the pairing lands in the local settings,
// and that the key goes to the right setting on the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSetup, type Asker } from './setup.js';
import type { SshRun } from './provision.js';

function scripted(answers: { text?: string[]; select?: string[]; password?: string[] }): Asker & { asked: string[] } {
  const q = { text: [...(answers.text ?? [])], select: [...(answers.select ?? [])], password: [...(answers.password ?? [])] };
  const asked: string[] = [];
  return {
    asked,
    text: async (m) => { asked.push(`text:${m}`); return q.text.shift(); },
    select: async (m) => { asked.push(`select:${m}`); return q.select.shift(); },
    password: async (m) => { asked.push(`password:${m}`); return q.password.shift(); },
  };
}

test('runSetup: install (ssh owns the tty, script fetched by the box), read the pairing, save it, verify, push the key', async () => {
  const calls: { args: string[]; tty?: boolean; stdin?: string }[] = [];
  const run: SshRun = async (args, { tty, stdin }) => {
    calls.push({ args, tty, stdin });
    const cmd = args.at(-1) ?? '';
    if (cmd.includes('PHANTOM_FACT')) return { code: 0, out: 'PHANTOM_FACT PHANTOM_BACKEND_ADDRESS=203.0.113.7\nPHANTOM_FACT PHANTOM_BACKEND_PORT=8080\nPHANTOM_FACT PHANTOM_BACKEND_TLS=public\nPHANTOM_FACT API_KEY=k123\n' };
    return { code: 0, out: '' };
  };
  const patched: Record<string, unknown>[] = [];
  const api = () => async (method: string, path: string, body?: unknown) => {
    if (method === 'PATCH' && path.startsWith('/settings')) { patched.push(body as Record<string, unknown>); return {}; }
    return {};
  };
  const ask = scripted({ text: ['root@203.0.113.7'], select: ['anthropic'], password: ['sk-ant-xyz'] });
  const configPath = join(mkdtempSync('/tmp/phantom-setup-'), 'settings.json');
  await runSetup({
    run, ask, api: api as never, configPath,
    verify: async () => ({ ok: true, version: '0.1.0' }),
    exit: ((c: number) => { throw new Error(`exit ${c}`); }) as never,
  });

  // the install: terminal handed to ssh, -t, script NOT on stdin, fetched by the box, --yes
  const install = calls[0];
  assert.equal(install.tty, true);
  assert.ok(install.args.includes('-t'));
  assert.equal(install.stdin, undefined);
  const cmd = install.args.at(-1)!;
  assert.match(cmd, /curl -fsSL https:\/\/raw\.githubusercontent\.com\/stephengpope\/phantom-looper\/[^ ]+\/scripts\/install\.sh/);
  assert.match(cmd, /\| sh -s -- --yes$/);
  // one password for the run: every call shares the control socket
  for (const c of calls) assert.ok(c.args.join(' ').includes('ControlPath='), c.args.join(' '));
  // then the pairing read-back (no tty), then the master closed at the end
  assert.equal(calls[1].tty, undefined);
  assert.ok(calls[1].args.at(-1)!.includes('PHANTOM_FACT'));
  assert.deepEqual(calls.at(-1)!.args.slice(0, 2), ['-O', 'exit']);
  // the pairing is in the local file
  const saved = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(saved.server_url, 'https://203.0.113.7');
  assert.equal(saved.server_key, 'k123');
  // and the key went to the right setting
  assert.deepEqual(patched, [{ anthropic_api_key: 'sk-ant-xyz', provider: 'anthropic' }]);
  assert.deepEqual(ask.asked.map((a) => a.split(':')[0]), ['text', 'select', 'password']);
});

test('runSetup: backing out of the first question exits 0 with nothing written', async () => {
  const ask = scripted({ text: [] });
  let code: number | undefined;
  await runSetup({ ask, run: async () => { throw new Error('ssh must not run'); }, exit: ((c: number) => { code = c; throw new Error('exit'); }) as never })
    .catch((e) => assert.equal((e as Error).message, 'exit'));
  assert.equal(code, 0);
});

test('runSetup: a failed install is reported and the target is asked again', async () => {
  let n = 0;
  const run: SshRun = async (args) => {
    const cmd = args.at(-1) ?? '';
    if (cmd.includes('PHANTOM_FACT')) return { code: 0, out: 'PHANTOM_FACT PHANTOM_BACKEND_ADDRESS=h\nPHANTOM_FACT API_KEY=k\n' };
    if (args[0] === '-O') return { code: 0, out: '' };
    return { code: n++ === 0 ? 7 : 0, out: '' };
  };
  const ask = scripted({ text: ['root@a', 'root@b'], select: [''] });
  await runSetup({ run, ask, verify: async () => ({ ok: true, version: 'x' }), api: (() => async () => ({})) as never,
    configPath: join(mkdtempSync('/tmp/phantom-setup-'), 'settings.json'),
    exit: ((c: number) => { throw new Error(`exit ${c}`); }) as never });
  assert.equal(ask.asked.filter((a) => a.startsWith('text')).length, 2);
});
