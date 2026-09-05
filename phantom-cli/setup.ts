// `phantom-cli setup-backend` — installs a phantom-backend server over ssh,
// pairs this machine with it, and collects everything the app cannot run
// without: a provider, its model, its key, and the GitHub token. A server
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
// The questions, in order: where the server goes · the provider (no default —
// nothing runs until one is chosen) · its endpoint, for openai-compatible ·
// the model, a combobox over the server's catalog (GET /models) · the key ·
// the GitHub token, verified against GitHub before it is accepted. None is
// skippable: without any one of them the app cannot run a card. Backing out
// after the pairing keeps it and names the screens that finish the job.
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
  /** A combobox: typing filters `options`, and text that matches none of them
   *  is offered as itself — a model the catalog does not list is one field away. */
  autocomplete(message: string, options: { value: string; label: string; hint?: string }[]): Promise<string | undefined>;
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
  autocomplete: (message, options) => onTty((input) => clack.autocomplete<string>({
    message, input, maxItems: 8, placeholder: 'type to filter, or type any id',
    // The options are a getter so the typed text can join the list: what you
    // typed, when it is not already a row, is the last row.
    options() {
      const typed = this.userInput.trim();
      const q = typed.toLowerCase();
      const rows = options.filter((o) => !q || o.value.toLowerCase().includes(q) || o.label.toLowerCase().includes(q));
      if (typed && !options.some((o) => o.value === typed)) rows.push({ value: typed, label: `use "${typed}"` });
      return rows;
    },
    filter: () => true,   // the getter already filtered
  })),
};

interface Paired { url: string; key: string; ca?: string }

/** The server's catalog for one provider (GET /models), newest first; [] when
 *  the provider has none (openai-compatible) or the call fails — the question
 *  falls back to a typed id. */
async function catalogFor(settings: ReturnType<typeof makeSettings>, provider: string):
Promise<{ id: string; name: string }[]> {
  try {
    const r = await settings.api('GET', `/models?provider=${encodeURIComponent(provider)}`) as
      { models?: { id: string; name: string }[] };
    return Array.isArray(r?.models) ? r.models : [];
  } catch { return []; }
}

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
 *  (local settings written) and the provider, model, key and GitHub token
 *  are saved on the server; exits when the person backs out, or when the
 *  pairing is saved but the server is not yet reachable from here — with the
 *  reason and the fix on screen. */
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

  // What the app cannot run without, into the server's store — the same
  // rows /model and /keys edit later. Backing out here keeps the pairing.
  const settings = makeSettings(api(paired.url, paired.key, paired.ca));
  const bail = async (): Promise<never> => {
    clack.cancel('paired, but not set up — finish on /model and /keys in phantom-cli');
    if (target) await closeSshMaster(target, sshOpts);
    return exit(0);
  };

  // 1. the provider — no default, no preselection.
  const provider = await ask.select('which AI provider?', PROVIDERS.map((p) => ({
    value: p as string, label: p as string,
    hint: p === 'anthropic' ? 'API key or Claude subscription token'
      : p === 'openai-compatible' ? 'Ollama, vLLM, OpenRouter — any OpenAI-shaped endpoint' : undefined,
  })));
  if (!provider) return bail();

  // 2. its endpoint, only where the provider IS an endpoint.
  let baseUrl: string | undefined;
  if (provider === 'openai-compatible') {
    baseUrl = await ask.text('the endpoint (base URL)', (v) => {
      try { new URL(v); return undefined; } catch { return 'a URL, like http://localhost:11434/v1'; }
    });
    if (baseUrl === undefined) return bail();
  }

  // 3. the model — the server's catalog, newest first, or any id typed.
  const models = await catalogFor(settings, provider);
  const model = models.length
    ? await ask.autocomplete(`${provider} model — newest first`, models.map((m) => ({
      value: m.id, label: m.name, hint: m.id === m.name ? undefined : m.id })))
    : await ask.text(`${provider} model id`, (v) => (v.trim() ? undefined : 'a model id is needed'));
  if (!model?.trim()) return bail();

  // 4. the key. A failed save is reported and asked again.
  for (;;) {
    const key = await ask.password(`${provider} — paste the key`);
    if (key === undefined) return bail();
    if (!key.trim()) continue;
    try {
      await settings.patch({
        provider, model: model.trim(), ...(baseUrl ? { base_url: baseUrl.trim() } : {}),
        [PROVIDER_KEY[provider as keyof typeof PROVIDER_KEY]]: key.trim(),
      });
      clack.log.success(`${provider} · ${model.trim()} — key saved on the server`);
      break;
    } catch (e) {
      clack.log.error((e as Error).message);
    }
  }

  // 5. the GitHub token, checked against GitHub the moment it is saved — a
  // mistyped or expired one is caught HERE, not at the first clone.
  for (;;) {
    const token = await ask.password('GitHub token — a classic token with repo scope: clones, pushes, lands work');
    if (token === undefined) return bail();
    if (!token.trim()) continue;
    try {
      await settings.patch({ github_token: token.trim() });
      const who = await settings.api('GET', '/github/whoami') as { login?: string };
      clack.log.success(`github token saved — authenticated as ${String(who?.login ?? 'unknown')}`);
      break;
    } catch (e) {
      clack.log.error(`${(e as Error).message} — paste it again`);
    }
  }
  if (target) await closeSshMaster(target, sshOpts);
  clack.outro('done — run phantom-cli');
}
