// Ink TUI coding agent over phantom-backend — the hello-world client.
//
//   npm run phantom-cli                              # a new session, ready to work
//   npm run phantom-cli -- --resume <session-id>     # straight back into one
//   phantom-cli setup-backend                # install a server over ssh, pair, exit
//
// Inside: /new for another session here, /resume to reopen an earlier one,
// /workspace to start in a different one. They all JOIN this window rather
// than replacing what is in it — every session you open stays open and keeps
// running. tab and shift+tab walk between them (most recently spoken to
// first); ctrl+n lists them.
//
// The machine-local settings live in ~/.phantom-cli/settings.json; everything
// else is on the server, edited in-app with /settings and /model. Env vars
// still override the file, and reach ONLY the local keys (PHANTOM_BACKEND_URL,
// PHANTOM_BACKEND_KEY) — the settings screen shows which source each value
// came from.
import { appendFileSync } from 'node:fs';
import { format } from 'node:util';
import { join } from 'node:path';
import { render } from 'ink';
import { phantomTools } from '../core/llm/tools/workspace.js';
import { skillTools } from '../core/llm/tools/skills.js';
import { webTools } from '../core/llm/tools/web.js';
import { secretTools } from '../core/llm/tools/secrets.js';
import { codingGitTools, autoPullSession as corePull } from '../core/llm/tools/git.js';
import { newId } from '../core/ids.js';
import { App } from './App.js';
import { createScreen } from './screen.js';
import { MOUSE_OFF, MOUSE_ON } from './mouse.js';
import { CONFIG_DIR, type ConfigValue } from './config.js';
import { resolveLocal, localValues } from './local.js';
import { ndjson } from '../core/ndjson.js';
import { apiFor, savedCaFor } from './provision.js';
import { APP_VERSION, checkLatest, isBehind, selfUpdate } from './selfUpdate.js';
import { makeSettings } from './settings.js';

// The connection comes from the file, synchronously: it is how we REACH the
// settings store, so it cannot come from it — and you edit it precisely when
// the server is unreachable.
const { error: configError } = resolveLocal();
function die(msg: string): never { console.error(msg); process.exit(1); }
if (configError) console.error(configError);

// Subcommands run headless, ahead of the TTY gate: the version, and the
// update pair — this cli's own, and the server's. One tag cuts both halves
// (release.yml), so the server's upgrade tag IS this cli's version, handed to
// the server's own updater over POST /update.
const firstArg = process.argv[2];
if (firstArg === '--version' || firstArg === '-v') { console.log(APP_VERSION); process.exit(0); }
if (firstArg === 'update') {
  if (process.argv.includes('--server')) {
    const l = localValues();
    if (!l.server_key) die('no server paired — run phantom-cli once first');
    const call = apiFor(String(l.server_url), String(l.server_key), savedCaFor(String(l.server_url)));
    const health = await call('GET', '/health') as { version?: string };
    const server = String(health?.version ?? 'unknown');
    if (APP_VERSION === 'dev') die(`the server runs ${server}; a dev checkout has no release tag to send — on the box: phantom-backend update vX.Y.Z`);
    if (!isBehind(server, APP_VERSION)) { console.log(`server is current (${server})`); process.exit(0); }
    await call('POST', '/update', { tag: `v${APP_VERSION}` });
    console.log(`requested v${APP_VERSION} — the server's updater applies it in the background`);
    process.exit(0);
  }
  const latest = await checkLatest();
  if (!latest) die('could not read the latest release from GitHub');
  if (!isBehind(APP_VERSION, latest)) { console.log(`already current (${APP_VERSION})`); process.exit(0); }
  console.log(await selfUpdate(latest));
  process.exit(0);
}

if (!process.stdin.isTTY) die('needs a TTY');

// `setup-backend` is the ONE way a new server gets installed: the wizard
// (setup.tsx) runs here, before the app, because ssh must own the tty. It
// pairs this machine and exits; the next plain launch is the app. A server
// that already exists is paired from inside the app, on /server.
if (firstArg === 'setup-backend') {
  const { runSetup } = await import('./setup.js');
  await runSetup();
  process.exit(0);
}

// The connection is read from the file at EVERY request, never captured at
// launch: /server rewrites the file while the app runs, and the next call
// must reach the new address with the new key — no relaunch. Nothing paired
// still opens the app; the boot note says where the two ways in are.
function connection(): { base: string; key: string } {
  const l = localValues();
  return { base: String(l.server_url), key: String(l.server_key ?? '') };
}

// An internal-TLS server's root certificate, saved by setup-backend: trusted
// for every fetch in this process. undici's connect.ca REPLACES the default
// roots, so they ride along with it. Re-applied whenever the address changes
// (a /server save), so a switch to another internal-TLS box works live; an
// address with no saved CA gets the plain defaults back.
let trustedFor: string | undefined;
async function trustSavedCa(base: string): Promise<void> {
  if (trustedFor === base) return;
  const savedCa = savedCaFor(base);
  if (!savedCa && trustedFor === undefined) { trustedFor = base; return; }
  const [{ Agent, setGlobalDispatcher }, { rootCertificates }] =
    await Promise.all([import('undici'), import('node:tls')]);
  setGlobalDispatcher(new Agent({ connect: savedCa ? { ca: [...rootCertificates, savedCa] } : {} }));
  trustedFor = base;
}
await trustSavedCa(connection().base);

// This window's session-lock identity: minted per process, sent on every call.
// The server compares it when a session is held; the label is what other
// windows see on the "in use" row.
const CLIENT_ID = newId();

// Version watch, in the background, printed at QUIT — the screen belongs to
// the app while it runs. One tag cuts the cli and the server, so "behind" is
// a compare of two release strings; a dev checkout ('dev') never nags.
let latestRelease: string | null = null;
if (APP_VERSION !== 'dev') void checkLatest().then((t) => { latestRelease = t; });
let serverVersion: string | null = null;

// /auto-push's step names, in words. Anything the server adds later shows raw.
const AUTO_PUSH_STEPS: Record<string, string> = {
  commit: 'committing',
  merge: 'merging the base branch in',
  fix: 'resolving conflicts',
  verify: 'verifying against the repo',
  push_branch: 'pushing the branch',
  push_base: 'pushing to the base branch',
  retry: 'base moved — merging again',
};

/** POST /git/auto-push and consume its ND-JSON stream. An auto-push has no time limit,
 *  so the route streams: heartbeats keep the connection alive, step records
 *  become notes, and exactly one result record ends it. */
export async function autoPushSession(sessionId: string, onStep?: (label: string) => void):
  Promise<{ result: string; reason?: string; sha?: string }> {
  const { base, key } = connection();
  await trustSavedCa(base);
  const r = await fetch(`${base}/git/auto-push`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json',
      'x-phantom-looper-session': sessionId, 'x-phantom-looper-client': CLIENT_ID },
    body: '{}',
  });
  // A refusal (unknown session, auto-push unwired) is the plain envelope, sent
  // before the stream would have started.
  if ((r.headers.get('content-type') ?? '').includes('application/json')) {
    const j = await r.json() as { ok: boolean; error?: { code?: string; message?: string } };
    throw new Error(j.error?.message ?? j.error?.code ?? `auto-push: HTTP ${r.status}`);
  }
  if (!r.body) throw new Error(`auto-push: HTTP ${r.status}`);
  let result: { result: string; reason?: string; sha?: string } | undefined;
  for await (const rec of ndjson(r.body) as AsyncIterable<{ event?: string; step?: string; result?: string; reason?: string; sha?: string }>) {
    if (rec.event === 'step' && rec.step) onStep?.(AUTO_PUSH_STEPS[rec.step] ?? rec.step);
    else if (rec.event === 'result') result = { result: rec.result ?? 'error', reason: rec.reason, sha: rec.sha };
  }
  if (!result) throw new Error('auto-push: the stream ended without a result');
  return result;
}

/** POST /git/auto-pull for one session — core's client over the same stream
 *  shape as auto-push; the cli adds only its connection, its lock identity and
 *  the saved CA (a self-signed backend must work for pull as it does for push). */
export async function autoPullSession(sessionId: string, onStep?: (label: string) => void) {
  const { base, key } = connection();
  await trustSavedCa(base);
  return corePull({ baseUrl: base, apiKey: key, sessionId, clientId: CLIENT_ID }, onStep);
}

/** GET a server stream (ND-JSON) as records — the board's live feed. Open
 *  until the signal aborts or the server hangs up; a refusal (the plain JSON
 *  envelope) throws with the server's message. */
export async function stream(path: string, signal: AbortSignal): Promise<AsyncIterable<Record<string, unknown>>> {
  const { base, key } = connection();
  await trustSavedCa(base);
  const r = await fetch(`${base}${path}`, {
    headers: { authorization: `Bearer ${key}`, 'x-phantom-looper-client': CLIENT_ID }, signal });
  if ((r.headers.get('content-type') ?? '').includes('application/json')) {
    const j = await r.json() as { error?: { code?: string; message?: string } };
    throw new Error(j.error?.message ?? j.error?.code ?? `GET ${path}: HTTP ${r.status}`);
  }
  if (!r.body) throw new Error(`GET ${path}: HTTP ${r.status}`);
  return ndjson(r.body);
}

export async function api(method: string, path: string, body?: unknown) {
  // content-type only WITH a body — Fastify 400s a bodyless application/json
  // request, which silently broke the lock release (DELETE) and left every
  // opened session "in use" for the whole TTL.
  const { base, key } = connection();
  await trustSavedCa(base);
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${key}`, 'x-phantom-looper-client': CLIENT_ID,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json() as { ok: boolean; data?: unknown; error?: { code?: string; message?: string } };
  if (!j.ok) {
    // The server's message IS the error people read — never the envelope's
    // JSON. The code rides as a property for callers that branch on it.
    const failed = new Error(j.error?.message || `${method} ${path}: HTTP ${r.status}`) as Error & { code?: string };
    failed.code = j.error?.code;
    throw failed;
  }
  return j.data as Record<string, unknown>;
}

// The server's version, for the quit-time staleness notice. Fire-and-forget:
// offline just means no notice.
void api('GET', '/health')
  .then((h) => { serverVersion = String((h as { version?: string }).version ?? ''); })
  .catch(() => { /* unreachable is its own, louder failure elsewhere */ });

const argv = process.argv.slice(2);
function flag(name: string, short?: string): string | undefined {
  const i = argv.findIndex((a) => a === name || a === short || a.startsWith(`${name}=`));
  if (i < 0) return undefined;
  const a = argv[i];
  return a.startsWith(`${name}=`) ? a.slice(name.length + 1) : argv[i + 1];
}
const resumeId = flag('--resume', '-r');

// The app opens FIRST, empty, and opens its own first session — the same flow
// /new and /workspace run. Nothing here may keep the window from coming up:
// the screens that fix a dead token or a wrong address are all inside it, so
// a launch-time failure has to land in the pane, not on a stack trace. What
// launching wants (resume this id, or find a workspace and start) rides the
// `boot` prop; App's boot effect does the rest.

// The coding kit factories: the seven file tools + the skill tools + web.
// `plan` is /plan's switch: the readonly preset on the mutating kits — the
// same rule the server's turn route applies for plan: true.
const skillKit = (id: string, plan?: boolean) =>
  skillTools({ baseUrl: connection().base, apiKey: connection().key, sessionId: id, ...(plan ? { pick: 'readonly' as const } : {}) });
const webKit = (id: string) => webTools({ baseUrl: connection().base, apiKey: connection().key, sessionId: id });
// Workspace-bound, not session-bound: the workspace's secrets shadow global
// ones by name, and only App knows which workspace a session is in.
const secretKit = (ws: string) => secretTools({ baseUrl: connection().base, apiKey: connection().key, workspaceId: ws });
// The coding agent's git_auto_pull, bound to its own session; a mutator, so
// plan mode drops it like the file tools' writers.
const gitKit = (id: string, plan?: boolean) =>
  codingGitTools({ baseUrl: connection().base, apiKey: connection().key, sessionId: id, clientId: CLIENT_ID, ...(plan ? { pick: 'readonly' as const } : {}) });
// Settings for the chrome's first frame (voice pane on/off, width). Best
// effort: unreachable just means defaults for one frame — the app is where an
// unreachable server gets fixed, so it must not die here.
const cfg: Record<string, ConfigValue> | undefined =
  await makeSettings(api).read().then((r) => ({ ...r, ...localValues() })).catch(() => undefined);

// The session you quit from is not necessarily the one you started in — /new,
// /resume, /workspace and tab all move it — so track the live one and print
// THAT id on the way out. One line, for the session you were actually in:
// listing every session you happened to open is a wall to read past. null
// until the first session opens — a window can now run without one.
let currentId: string | null = null;
// Every session this window opened, so each hold can be released on the way
// out. A crash skips this and relies on the lock's own expiry instead.
const openedIds = new Set<string>();

// Fullscreen, so the app owns the mouse: Ink draws through the screen mirror
// (selection needs to know what is on screen), and the terminal is asked to
// report mouse events for as long as we run — switched off again on every way
// out, or the shell inherits a mouse mode it does not understand.
const screen = createScreen(process.stdout);
const mouseOff = (): void => { try { process.stdout.write(MOUSE_OFF); } catch { /* gone */ } };
process.on('exit', mouseOff);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => { mouseOff(); process.exit(1); });

// A fullscreen app cannot show console output. Ink's answer to a console or
// stderr line is to ERASE THE WHOLE SCREEN, write the line, and repaint every
// row — measured on a live session: ~1,900 full repaints in 93 seconds, the
// "flicker all over". So while the screen is up, console.* and stderr go to a
// file instead (CONFIG_DIR/cli.log — React warnings land there with their
// component stacks), Ink's console patching stays OFF, and nothing may draw
// over the screen. Restored on the way out for the resume line.
const CLI_LOG = join(CONFIG_DIR, 'cli.log');
const origConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
const origStderrWrite = process.stderr.write.bind(process.stderr);
const toLog = (text: string): void => {
  try { appendFileSync(CLI_LOG, text.endsWith('\n') ? text : `${text}\n`); } catch { /* the screen matters more */ }
};
for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  // util.format, as console itself does: React's warnings are printf-style
  // ("same key, `%s`"), and a plain join logged the placeholder, not the key.
  console[m] = (...args: unknown[]) => toLog(format(...args));
}
process.stderr.write = ((chunk: string | Uint8Array, enc?: unknown, cb?: unknown): boolean => {
  toLog(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  const done = typeof enc === 'function' ? enc : cb;
  if (typeof done === 'function') done();
  return true;
}) as typeof process.stderr.write;
const restoreConsole = (): void => {
  Object.assign(console, origConsole);
  process.stderr.write = origStderrWrite as typeof process.stderr.write;
};

// A crash — a throw nothing catches, a rejection nothing handles — is Node
// printing the error and exiting. That print goes to the terminal's file
// descriptor from C++, past the redirect above, onto the alternate screen,
// which Ink discards on the way out (its teardown says so): the message is
// lost. So the error is written to cli.log first, the screen is torn down
// here, and the same text goes to the real terminal before the exit. Out of
// memory is not a throw — V8 aborts from C++ and no handler runs; only the
// terminal's own "FATAL ERROR" line records it.
let screenUp: { unmount(): void } | null = null;
const onCrash = (kind: string) => (err: unknown): void => {
  const text = `${kind}: ${err instanceof Error ? err.stack ?? err.message : format(err)}`;
  toLog(`[${new Date().toISOString()}] ${text}`);
  try { screenUp?.unmount(); } catch { /* the screen is what is broken */ }
  mouseOff();
  restoreConsole();
  try { origStderrWrite(`\nphantom-cli crashed — ${text}\nwritten to ${CLI_LOG}\n`); } catch { /* gone */ }
  process.exit(1);
};
process.on('uncaughtException', onCrash('uncaughtException'));
process.on('unhandledRejection', onCrash('unhandledRejection'));

const app = render(
  <App
    api={api}
    stream={stream}
    autoPush={autoPushSession}
    autoPull={autoPullSession}
    bootConfig={cfg}
    boot={{ ...(resumeId ? { resumeId } : {}) }}
    newTools={(id, plan, ws) => phantomTools({ baseUrl: connection().base, apiKey: connection().key, sessionId: id, ...(plan ? { pick: 'readonly' as const } : {}) })
      .then((t) => ({ ...t, ...skillKit(id, plan), ...webKit(id), ...(ws ? secretKit(ws) : {}), ...gitKit(id, plan) }))}
    newAssistantTools={(id) => phantomTools({ baseUrl: connection().base, apiKey: connection().key, sessionId: id, pick: 'readonly' })
      .then((t) => ({ ...t, ...webKit(id) }))}
    onSession={(s) => { currentId = s.id; openedIds.add(s.id); }}
    clientId={CLIENT_ID}
    screen={screen}
  />,
  // incrementalRendering: rewrite only the lines that changed, instead of
  // erasing and rewriting the whole screen every frame — the difference
  // between a steady pane and a flicker on terminals without synchronized
  // output (Apple Terminal). Its one hole — the line cache going stale when a
  // resize moves the screen under it — is covered by App's repaint-on-resize.
  // patchConsole: false — console output must NEVER trigger Ink's
  // erase-everything-and-repaint; it is redirected to cli.log above.
  { exitOnCtrlC: false, alternateScreen: true, stdout: screen.stream, incrementalRendering: true, patchConsole: false },
);
screenUp = app;
process.stdout.write(MOUSE_ON);
await app.waitUntilExit();
mouseOff();
restoreConsole();

// Release every hold this window took — best effort, quickly: quitting must
// not hang on a dead server, and the lock expires on its own anyway.
await Promise.allSettled([...openedIds].map((id) => api('DELETE', `/sessions/${id}/lock`)));

// Quitting is not the end of the session: its branch and its transcript are
// both still there. One line of prose and the command on its own line, so it
// can be selected and pasted whole — nothing else, because anything beside it
// is something to read past on the way to the thing you came for. A window
// that never opened a session has nothing to resume, and says nothing. The
// command matches how THIS process was launched — the installed binary, or
// the npm script from a checkout ('dev' is the checkout's version).
if (currentId) {
  const launch = APP_VERSION === 'dev' ? 'npm run phantom-cli --' : 'phantom-cli';
  console.log(`\nResume this session with:\n${launch} --resume ${currentId}\n`);
}

// The version notices wait for this quiet moment too — offered, never
// automatic, and only between release builds (isBehind refuses 'dev').
if (latestRelease && isBehind(APP_VERSION, latestRelease)) {
  console.log(`phantom-cli ${latestRelease} is out — update with:\nphantom-cli update\n`);
}
if (serverVersion && isBehind(serverVersion, APP_VERSION)) {
  console.log(`the server runs ${serverVersion}, this cli ${APP_VERSION} — update it with:\nphantom-cli update --server\n`);
}
