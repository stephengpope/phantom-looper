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
// PHANTOM_BACKEND_KEY, PHANTOM_CLI_AUTO_UPDATE) — the settings screen shows
// which source each value came from.
import { openSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { format } from 'node:util';
import { render } from 'ink';
import { phantomTools } from '../core/llm/tools/workspace.js';
import { skillTools } from '../core/llm/tools/skills.js';
import { webTools } from '../core/llm/tools/web.js';
import { secretTools } from '../core/llm/tools/secrets.js';
import { autoPushSession as corePush, autoPullSession as corePull } from '../core/llm/tools/git.js';
import { newId } from '../core/ids.js';
import { App } from './App.js';
import { createScreen } from './screen.js';
import { createCprFilter } from './cursorAudit.js';
import { MOUSE_OFF, MOUSE_ON } from './mouse.js';
import { CONFIG_DIR, type ConfigValue } from './config.js';
import { CLI_LOG_PATH, logLine } from './cliLog.js';
import { resolveLocal, localValues } from './local.js';
import { ndjson } from '../core/ndjson.js';
import { apiFor, savedCaFor } from './provision.js';
import { APP_VERSION, checkLatest, selfUpdate } from './selfUpdate.js';
import { CHECK_INTERVAL_MS, autoUpdateCycle, dueForCheck, prelaunchReconcile, stampChecked } from './autoUpdate.js';
import { quitNotice, runUpdate, versionLines } from './update.js';
import type { ServerLink, Target } from './update.js';
import { makeSettings } from './settings.js';
import { requestError } from './request.js';

// The connection comes from the file, synchronously: it is how we REACH the
// settings store, so it cannot come from it — and you edit it precisely when
// the server is unreachable.
const { error: configError } = resolveLocal();
function die(msg: string): never { console.error(msg); process.exit(1); }
if (configError) console.error(configError);

// Subcommands run headless, ahead of the TTY gate: the version, and the
// update. One tag cuts both halves (release.yml), so `update` brings this
// machine AND the server to the latest release; `--client` / `--server` take
// one half. The messages, the wait and the loop guard live in update.ts.
const firstArg = process.argv[2];

// Clears the current terminal line before reprinting it — the ticking waits
// (the update command's, the launch gate's) rewrite one line instead of
// scrolling. Empty off a TTY: there is no line to clear in a pipe.
const TTY_CLEAR = process.stdout.isTTY ? '\r\x1b[2K' : '';

/** The paired server as update.ts sees it — null when nothing is paired. */
function pairedServer(): ServerLink | null {
  const l = localValues();
  if (!l.server_key || !l.server_url) return null;
  const url = String(l.server_url);
  return { url, call: apiFor(url, String(l.server_key), savedCaFor(url)) };
}

if (firstArg === '--version' || firstArg === '-v') {
  const server = pairedServer();
  const version = server
    ? await server.call('GET', '/health').then((h) => String((h as { version?: string }).version ?? '') || null, () => null)
    : null;
  for (const line of versionLines(APP_VERSION, server ? { url: server.url, version } : null)) console.log(line);
  process.exit(0);
}
if (firstArg === 'update') {
  const flags = process.argv.slice(3);
  const bad = flags.find((f) => f !== '--client' && f !== '--server');
  if (bad) die(`unknown option ${bad}\nusage: phantom-cli update [--client] [--server]`);
  const target: Target = flags.includes('--client') && !flags.includes('--server') ? 'client'
    : flags.includes('--server') && !flags.includes('--client') ? 'server' : 'both';
  // The ticking wait rewrites its line; every real line clears it first.
  const code = await runUpdate(target, {
    appVersion: APP_VERSION,
    latest: checkLatest,
    server: pairedServer(),
    installClient: selfUpdate,
    confirm: askYesNo,
    out: (line) => { process.stdout.write(TTY_CLEAR + line + '\n'); },
    tick: process.stdout.isTTY ? (line) => { process.stdout.write(TTY_CLEAR + line); } : undefined,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
  });
  process.exit(code);
}

/** One yes/no question on the terminal itself. No terminal — the answer is no. */
async function askYesNo(question: string): Promise<boolean> {
  let fd: number;
  try { fd = openSync('/dev/tty', 'r+'); } catch { return false; }
  const { ReadStream } = await import('node:tty');
  const { createInterface } = await import('node:readline');
  const input = new ReadStream(fd);
  try {
    const rl = createInterface({ input, output: process.stdout });
    const answer = await new Promise<string>((r) => rl.question(question, r));
    rl.close();
    return /^y(es)?$/i.test(answer.trim());
  } finally { input.destroy(); }
}

if (!process.stdin.isTTY) die('needs a TTY');

// `setup-backend` is the ONE way a new server gets installed: the wizard
// (setup.ts — plain prompts, no Ink) runs here, before the app, because ssh
// must own the terminal. It pairs this machine and exits; the next plain
// launch is the app. A server that already exists is paired on /server.
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

// Version watch, in the background — the screen belongs to the app while it
// runs. Gated by a stamp file to about once a day, at launch and on an unref'd
// daily timer for windows that stay open (autoUpdate.ts). With auto_update on,
// a new release installs itself: the prompt's version label swaps to "ready —
// runs next launch" and the quit line repeats it. Off: no install, and the
// quit notice offers `phantom-cli update` as before. One tag cuts the cli and
// the server, so "behind" is a compare of two release strings; a dev checkout
// ('dev') never nags.
let latestRelease: string | null = null;
let installedVersion: string | null = null;
let serverVersion: string | null = null;
// The window store, handed up by App (the onWindow prop) once it exists — a
// finished install lights up the version label through it.
let windowStore: { setUpdateReady(v: string): void } | null = null;
function versionWatch(): void {
  // One install per run: once a version is ready, the label already says so
  // and re-installing the same tag daily would be pure waste.
  if (APP_VERSION === 'dev' || installedVersion || !dueForCheck(Date.now())) return;
  stampChecked(Date.now());
  void autoUpdateCycle({
    appVersion: APP_VERSION,
    autoUpdate: localValues().auto_update !== false,
    latest: checkLatest,
    install: selfUpdate,
  }).then((r) => {
    latestRelease = r.latest;
    if (r.installed) {
      installedVersion = r.installed;
      windowStore?.setUpdateReady(r.installed);
    }
  });
}
// The launch gate (autoUpdate.ts): bring both halves to the latest release
// BEFORE the app opens, through the ONE update flow (`phantom-cli update`'s
// runUpdate) — no session is open yet, so nothing is interrupted and no lock
// is ever taken by a build that is about to be replaced. A client half that
// landed re-execs into the new build.
await prelaunchReconcile({
  appVersion: APP_VERSION,
  latest: checkLatest,
  server: pairedServer(),
  installClient: selfUpdate,
  confirm: askYesNo,
  out: (line) => { process.stdout.write(TTY_CLEAR + line + '\n'); },
  tick: process.stdout.isTTY ? (line) => { process.stdout.write(TTY_CLEAR + line); } : undefined,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: Date.now,
  reexec: (version) => {
    // One hop, never a loop: the new process carries the marker, so a server
    // still ahead of it (ahead of the latest PUBLISHED release — a manual
    // tag) opens mismatched with the quit notice instead of re-execing forever.
    if (process.env.PHANTOM_CLI_REEXEC) return;
    const r = spawnSync(join(CONFIG_DIR, 'app', version, 'bin', 'phantom-cli'), process.argv.slice(2), {
      stdio: 'inherit', env: { ...process.env, PHANTOM_CLI_REEXEC: '1' },
    });
    process.exit(r.status ?? 0);
  },
});

// After the gate: it stamps the check when it runs one, so this skips itself
// on the launches the gate already covered — its job is the windows the gate
// does not (unpaired, an unreachable server) and windows that stay open.
versionWatch();
setInterval(versionWatch, CHECK_INTERVAL_MS).unref();

/** POST /git/auto-push for one session — core's client over the ND-JSON
 *  stream (heartbeats keep the connection alive, step records become notes,
 *  exactly one result record ends it); the cli adds only its connection, its
 *  lock identity and the saved CA. */
export async function autoPushSession(sessionId: string, onStep?: (label: string) => void) {
  const { base, key } = connection();
  await trustSavedCa(base);
  return corePush({ baseUrl: base, apiKey: key, sessionId, clientId: CLIENT_ID }, onStep);
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
  let r: Response;
  try {
    r = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${key}`, 'x-phantom-looper-client': CLIENT_ID }, signal });
  } catch (e) { throw requestError('GET', path, base, e); }
  if ((r.headers.get('content-type') ?? '').includes('application/json')) {
    const j = await r.json() as { error?: { code?: string; message?: string } };
    throw requestError('GET', path, base, undefined, { status: r.status, ...j.error });
  }
  if (!r.body) throw requestError('GET', path, base, undefined, { status: r.status });
  return ndjson(r.body);
}

export async function api(method: string, path: string, body?: unknown) {
  // content-type only WITH a body — Fastify 400s a bodyless application/json
  // request, which silently broke the lock release (DELETE) and left every
  // opened session "in use" for the whole TTL.
  const { base, key } = connection();
  await trustSavedCa(base);
  let r: Response;
  let j: { ok: boolean; data?: unknown; error?: { code?: string; message?: string } };
  try {
    r = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, 'x-phantom-looper-client': CLIENT_ID,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    j = await r.json() as typeof j;
  } catch (e) { throw requestError(method, path, base, e); }
  if (!j.ok) throw requestError(method, path, base, undefined, { status: r.status, ...j.error });
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
// Settings for the chrome's first frame (voice pane on/off, sidebar width).
// Started here, not awaited: the app renders immediately with defaults and
// the mount effect (readCfg → setChrome) corrects them as soon as the read
// lands — one frame of default chrome at most. The old await blocked the
// entire render on a network call, delaying the splash screen.
const cfgPromise = makeSettings(api).read().then((r) => ({ ...r, ...localValues() })).catch(() => undefined);
const cfg: Record<string, ConfigValue> | undefined = await Promise.race([
  cfgPromise,
  // Yield immediately if the settings haven't arrived yet — the app opens
  // on defaults and the mount effect corrects them when the read lands.
  new Promise<undefined>((r) => setTimeout(() => r(undefined), 0)),
]);

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
// Cursor-position replies (the screen audit's, cursorAudit.ts) ride stdin
// like mouse reports do — but unlike the mouse nothing else may see them, so
// they are filtered out of the stream Ink reads; everything else passes.
const stdin = createCprFilter(process.stdin, (at) => screen.cpr(at.row, at.col));
const mouseOff = (): void => { try { process.stdout.write(MOUSE_OFF); } catch { /* gone */ } };
process.on('exit', mouseOff);
// A DSR query in flight at exit gets its answer after we are gone — and the
// shell reads it as typed input (`^[[41;1R` at the prompt). So every way out
// stops the audit, and if a query WAS out we linger briefly before exiting:
// the CPR filter is still reading stdin, so the reply is swallowed by us.
// Terminals answer DSR in single-digit milliseconds; 150ms is generous.
const CPR_DRAIN_MS = 150;
// Raw mode again for the drain itself: with canonical mode back on (Ink
// restores it on the way out) the line discipline HOLDS a reply — it has no
// newline — and hands it to the next reader, the shell. That is the leak.
const drainCpr = async (): Promise<void> => {
  try { process.stdin.setRawMode(true); } catch { /* not a tty */ }
  await new Promise((r) => setTimeout(r, CPR_DRAIN_MS));
  try { process.stdin.setRawMode(false); } catch { /* not a tty */ }
};
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => {
  mouseOff();
  if (screen.stopAudit()) setTimeout(() => process.exit(1), CPR_DRAIN_MS);
  else process.exit(1);
});

// A fullscreen app cannot show console output. Ink's answer to a console or
// stderr line is to ERASE THE WHOLE SCREEN, write the line, and repaint every
// row — measured on a live session: ~1,900 full repaints in 93 seconds, the
// "flicker all over". So while the screen is up, console.* and stderr go to a
// file instead (CONFIG_DIR/cli.log — React warnings land there with their
// component stacks), Ink's console patching stays OFF, and nothing may draw
// over the screen. Restored on the way out for the resume line.
const CLI_LOG = CLI_LOG_PATH;
const origConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
const origStderrWrite = process.stderr.write.bind(process.stderr);
const toLog = logLine;
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
  toLog(text);
  try { screenUp?.unmount(); } catch { /* the screen is what is broken */ }
  const lateReply = screen.stopAudit();
  mouseOff();
  restoreConsole();
  try { origStderrWrite(`\nphantom-cli crashed — ${text}\nwritten to ${CLI_LOG}\n`); } catch { /* gone */ }
  if (lateReply) setTimeout(() => process.exit(1), CPR_DRAIN_MS);
  else process.exit(1);
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
      .then((t) => ({ ...t, ...skillKit(id, plan), ...webKit(id), ...(ws ? secretKit(ws) : {}) }))}
    newAssistantTools={(id) => phantomTools({ baseUrl: connection().base, apiKey: connection().key, sessionId: id, pick: 'readonly' })
      .then((t) => ({ ...t, ...webKit(id) }))}
    onSession={(s) => { currentId = s.id; openedIds.add(s.id); }}
    onWindow={(w) => { windowStore = w; if (installedVersion) w.setUpdateReady(installedVersion); }}
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
  { exitOnCtrlC: false, alternateScreen: true, stdin, stdout: screen.stream, incrementalRendering: true, patchConsole: false },
);
screenUp = app;
process.stdout.write(MOUSE_ON);
await app.waitUntilExit();
// Stop the audit the moment the screen is down: its teardown frames wrote
// through the mirror and re-armed the settle timer, and the lock releases
// below keep us alive long enough for it to fire — a DSR asked after the
// alternate screen is gone, answered into the user's shell.
const lateReply = screen.stopAudit();
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

// The version notice waits for this quiet moment too. An auto-updated machine
// is told its new version is ready; anything still behind (the server, or this
// machine with auto_update off) is offered `phantom-cli update`. A dev
// checkout is never behind, so from a checkout only the server is named.
const notice = quitNotice(APP_VERSION, serverVersion || null, latestRelease, installedVersion);
if (notice) console.log(`${notice}\n`);

// Last thing: if a DSR was in flight when the screen came down, linger so
// its reply is swallowed by the CPR filter (still reading stdin) instead of
// landing in the shell's input buffer.
if (lateReply) await drainCpr();
