// The setup-backend flow with every edge scripted: the questions (Asker), ssh
// (SshRun), the client-side verify and the server api. What is pinned: the
// order of the steps, that the install hands ssh the terminal and never
// pipes the script over stdin, that the pairing lands in the local settings,
// that provider + model + key land in one patch, and that the GitHub token is
// checked against GitHub before the wizard accepts it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runSetup, type Asker } from './setup.js';
import type { SshRun } from './provision.js';

function scripted(answers: { text?: string[]; select?: string[]; password?: string[]; autocomplete?: string[] }):
Asker & { asked: string[]; offered: string[][] } {
  const q = { text: [...(answers.text ?? [])], select: [...(answers.select ?? [])],
    password: [...(answers.password ?? [])], autocomplete: [...(answers.autocomplete ?? [])] };
  const asked: string[] = [];
  const offered: string[][] = [];
  return {
    asked, offered,
    text: async (m) => { asked.push(`text:${m}`); return q.text.shift(); },
    select: async (m, options) => { asked.push(`select:${m}`); offered.push(options.map((o) => o.value)); return q.select.shift(); },
    password: async (m) => { asked.push(`password:${m}`); return q.password.shift(); },
    autocomplete: async (m, options) => { asked.push(`autocomplete:${m}`); offered.push(options.map((o) => o.value)); return q.autocomplete.shift(); },
  };
}

const FACTS = 'PHANTOM_FACT PHANTOM_BACKEND_ADDRESS=203.0.113.7\nPHANTOM_FACT PHANTOM_BACKEND_PORT=8080\nPHANTOM_FACT PHANTOM_BACKEND_TLS=public\nPHANTOM_FACT API_KEY=k123\n';
const CATALOG = { models: [{ id: 'claude-fable-5-1', name: 'Claude Fable 5.1' }, { id: 'claude-opus-5', name: 'Claude Opus 5' }] };

/** A server api that records patches, serves the catalog and answers the
 *  GitHub check — `whoami` scripts that answer (a throw = GitHub refused). */
function serverApi(whoami: Array<{ login: string } | Error> = [{ login: 'octocat' }]) {
  const patched: Record<string, unknown>[] = [];
  const api = () => async (method: string, path: string, body?: unknown) => {
    if (method === 'PATCH' && path.startsWith('/settings')) { patched.push(body as Record<string, unknown>); return {}; }
    if (method === 'GET' && path.startsWith('/models')) return path.includes('openai-compatible') ? { models: [] } : CATALOG;
    if (method === 'GET' && path === '/github/whoami') {
      const a = whoami.shift() ?? { login: 'octocat' };
      if (a instanceof Error) throw a;
      return a;
    }
    return {};
  };
  return { api, patched };
}

const exitThrows = ((c: number) => { throw new Error(`exit ${c}`); }) as never;
const okSsh: SshRun = async (args) => (args.at(-1) ?? '').includes('PHANTOM_FACT') ? { code: 0, out: FACTS } : { code: 0, out: '' };

test('runSetup: install (ssh owns the tty, script fetched by the box), read the pairing, save it, verify, then provider · model · key · GitHub token', async () => {
  const calls: { args: string[]; tty?: boolean; stdin?: string }[] = [];
  const run: SshRun = async (args, opts) => { calls.push({ args, tty: opts.tty, stdin: opts.stdin }); return okSsh(args, opts); };
  const { api, patched } = serverApi();
  const ask = scripted({ text: ['root@203.0.113.7'], select: ['anthropic'], autocomplete: ['claude-fable-5-1'],
    password: ['sk-ant-xyz', 'ghp_abc'] });
  const configPath = join(mkdtempSync('/tmp/phantom-setup-'), 'settings.json');
  await runSetup({
    run, ask, api: api as never, configPath,
    verify: async () => ({ ok: true, version: '0.1.0' }),
    exit: exitThrows,
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
  // provider + model + key in ONE patch, then the token on its own
  assert.deepEqual(patched, [
    { provider: 'anthropic', model: 'claude-fable-5-1', anthropic_api_key: 'sk-ant-xyz' },
    { github_token: 'ghp_abc' },
  ]);
  assert.deepEqual(ask.asked.map((a) => a.split(':')[0]), ['text', 'select', 'autocomplete', 'password', 'password']);
  // no provider is preselected: the four are offered, none first by default
  assert.deepEqual(ask.offered[0], ['anthropic', 'openai', 'google', 'openai-compatible']);
  // the model question is the server's catalog, newest first
  assert.deepEqual(ask.offered[1], ['claude-fable-5-1', 'claude-opus-5']);
});

test('runSetup: openai-compatible asks the endpoint and a typed model (no catalog), and stores base_url', async () => {
  const { api, patched } = serverApi();
  const ask = scripted({ text: ['root@203.0.113.7', 'http://localhost:11434/v1', 'qwen3'], select: ['openai-compatible'],
    password: ['none', 'ghp_abc'] });
  await runSetup({ run: okSsh, ask, api: api as never, verify: async () => ({ ok: true, version: 'x' }), exit: exitThrows,
    configPath: join(mkdtempSync('/tmp/phantom-setup-'), 'settings.json') });
  assert.deepEqual(patched[0], { provider: 'openai-compatible', model: 'qwen3', base_url: 'http://localhost:11434/v1',
    openai_compatible_api_key: 'none' });
  assert.deepEqual(ask.asked.map((a) => a.split(':')[0]), ['text', 'select', 'text', 'text', 'password', 'password']);
});

test('runSetup: a GitHub token GitHub refuses is asked again; the wizard ends on one that works', async () => {
  const { api, patched } = serverApi([new Error('GitHub rejected the stored github_token'), { login: 'octocat' }]);
  const ask = scripted({ text: ['root@h'], select: ['anthropic'], autocomplete: ['claude-opus-5'],
    password: ['sk-ant-xyz', 'ghp_bad', 'ghp_good'] });
  await runSetup({ run: okSsh, ask, api: api as never, verify: async () => ({ ok: true, version: 'x' }), exit: exitThrows,
    configPath: join(mkdtempSync('/tmp/phantom-setup-'), 'settings.json') });
  assert.deepEqual(patched.slice(1), [{ github_token: 'ghp_bad' }, { github_token: 'ghp_good' }]);
  assert.equal(ask.asked.filter((a) => a.startsWith('password:GitHub')).length, 2);
});

test('runSetup: backing out at the provider keeps the pairing and exits 0 — nothing is skippable', async () => {
  const { api, patched } = serverApi();
  const ask = scripted({ text: ['root@203.0.113.7'], select: [] });
  const configPath = join(mkdtempSync('/tmp/phantom-setup-'), 'settings.json');
  let code: number | undefined;
  await runSetup({ run: okSsh, ask, api: api as never, configPath, verify: async () => ({ ok: true, version: 'x' }),
    exit: ((c: number) => { code = c; throw new Error('exit'); }) as never })
    .catch((e) => assert.equal((e as Error).message, 'exit'));
  assert.equal(code, 0);
  assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).server_key, 'k123', 'the pairing stands');
  assert.deepEqual(patched, [], 'nothing half-configured on the server');
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
  const ask = scripted({ text: ['root@a', 'root@b'], select: ['anthropic'], autocomplete: ['m'], password: ['k', 't'] });
  await runSetup({ run, ask, verify: async () => ({ ok: true, version: 'x' }), api: serverApi().api as never,
    configPath: join(mkdtempSync('/tmp/phantom-setup-'), 'settings.json'), exit: exitThrows });
  assert.equal(ask.asked.filter((a) => a.startsWith('text')).length, 2);
});
