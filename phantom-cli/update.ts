// `phantom-cli update`, `--version`, and the quit-time version notice.
//
// One release tag builds the cli and the server together (release.yml), so
// "current" means both halves on the latest PUBLISHED release. Plain `update`
// brings both there, client first; `--client` / `--server` take one half. The
// target is always the latest release, never the running cli's version — a
// dev checkout has no tag, and after the client half runs the process is still
// the OLD build, so posting its own version would tell the server to stay put.
// Skipping a half is allowed; the next quit names whatever is still behind
// (quitNotice), in either direction.
//
// The server half streams: POST /update returns ND-JSON progress events
// (core/update.ts) as the server pulls the images and the installer copies
// the release files and restarts the stack — the installer's own lines are
// relayed as they print, so a failure arrives with its reason the moment it
// happens. The restart cuts the stream; the CLI then health-polls until the
// server comes back on the new version.
//
// Everything reaches this module through `deps`, so a caller can script a
// release, a server and a clock without a network or a terminal.
import { isBehind } from './selfUpdate.js';
import { pullLine, type PullProgress, type UpdateEvent } from 'phantom-client-sdk';

export type Target = 'both' | 'client' | 'server';

export interface ServerLink {
  url: string;
  call(method: string, path: string, body?: unknown): Promise<unknown>;
  /** Open a streaming POST and call `onEvent` for each ND-JSON line.
   *  Resolves when the stream closes. */
  stream(path: string, body: unknown, onEvent: (event: unknown) => void): Promise<void>;
}

export interface UpdateDeps {
  /** APP_VERSION — '0.1.2', or 'dev' from a checkout. */
  appVersion: string;
  /** The latest published release tag ('v0.1.3'), null when GitHub is unreachable. */
  latest(): Promise<string | null>;
  /** The paired server, or null when nothing is paired. */
  server: ServerLink | null;
  /** selfUpdate(tag) — download, verify, unpack, install (link + prune). */
  installClient(tag: string): Promise<unknown>;
  /** Ask the person a yes/no question. */
  confirm(question: string): Promise<boolean>;
  /** Print one line (terminated, moves to the next line). */
  out(line: string): void;
  /** Overwrite the current line in place (\r). Absent = non-TTY, ticks skip. */
  tick?(line: string): void;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
  pollMs?: number;
  timeoutMs?: number;
}

export const POLL_MS = 3_000;
export const TIMEOUT_MS = 300_000;

/** 'v0.1.3' → '0.1.3'. */
export function bare(version: string): string { return version.replace(/^v/, ''); }

export interface Health { version?: string; loops_running?: number }

/** GET /api/health, null when the server cannot be reached. Exported for the
 *  launch gate (autoUpdate.ts), which reconciles versions before the app opens. */
export async function readHealth(server: ServerLink): Promise<Health | null> {
  try { return await server.call('GET', '/health') as Health; } catch { return null; }
}

function errorText(event: unknown): string { return event instanceof Error ? event.message : String(event); }

/** 72000 → '1m 12s'; 9000 → '9s'. */
export function elapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function minutes(milliseconds: number): string {
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

/** Poll /api/health until it reports `version`, or the timeout passes. */
async function waitForVersion(deps: UpdateDeps, server: ServerLink, version: string):
  Promise<{ ok: true; ms: number } | { ok: false; last: string | null }> {
  const start = deps.now();
  const timeout = deps.timeoutMs ?? TIMEOUT_MS;
  let last: string | null = null;
  for (;;) {
    const milliseconds = deps.now() - start;
    if (milliseconds >= timeout) return { ok: false, last };
    const tick = `  Waiting for server...  ${elapsed(milliseconds)}`;
    deps.tick ? deps.tick(tick) : deps.out(tick);
    await deps.sleep(deps.pollMs ?? POLL_MS);
    const health = await readHealth(server);
    if (!health) continue;
    if (health.version) {
      last = bare(String(health.version));
      if (last === version) return { ok: true, ms: deps.now() - start };
    }
  }
}

/** Stream progress from POST /update. The pull is one line updated in place
 *  ("Downloading server images:  api 42%  session 17%", then "Unpacking");
 *  each installer line is printed as it arrives. Resolves 'restarting' once
 *  the server is going down — said outright, or the stream dropping after the
 *  images landed, which is the restart cutting it — and 'error' when the
 *  server reports a failure or the connection is lost before that. */
async function streamUpdateProgress(deps: UpdateDeps, server: ServerLink, tag: string):
  Promise<'restarting' | 'error'> {
  const images: Record<string, PullProgress> = {};
  let pulled = false;
  let result: 'restarting' | 'error' | null = null;

  try {
    await server.stream('/update', { tag, restart_anyway: true }, (raw) => {
      const event = raw as UpdateEvent;
      if (event.event === 'pulling') {
        images[event.image] = { download: event.download, unpack: event.unpack };
        const line = `  ${pullLine(images)}`;
        deps.tick ? deps.tick(line) : deps.out(line);
      } else if (event.event === 'pulled') {
        pulled = true;
        deps.out('  Server images on disk.');
      } else if (event.event === 'installing') {
        deps.out(`  ${event.message.replace(/^apply: /, '')}`);
      } else if (event.event === 'restarting') {
        result = 'restarting';
      } else if (event.event === 'error') {
        result = 'error';
        deps.out(`  Update failed: ${event.message}`);
      }
      // heartbeat events are silently ignored
    });
  } catch (event) {
    if (result === null && !pulled) { deps.out(`  Update stream failed: ${errorText(event)}`); return 'error'; }
  }
  if (result === 'error') return 'error';
  if (result === null && !pulled) { deps.out('  The server ended the update without saying why.'); return 'error'; }
  deps.out('  Restarting...');
  return 'restarting';
}

/** The command. Returns the process exit code. */
export async function runUpdate(target: Target, deps: UpdateDeps): Promise<number> {
  const latest = await deps.latest();
  if (!latest) { deps.out('Could not reach GitHub to find the latest release.'); return 1; }
  const version = bare(latest);
  const wantClient = target !== 'server';
  const wantServer = target !== 'client';

  const health = wantServer && deps.server ? await readHealth(deps.server) : null;
  const serverVersion = health?.version ? bare(String(health.version)) : null;
  const clientBehind = isBehind(deps.appVersion, latest);
  const serverBehind = serverVersion ? isBehind(serverVersion, latest) : false;

  if (target === 'both' && serverVersion && deps.appVersion !== 'dev' && !clientBehind && !serverBehind) {
    deps.out(`This machine and the server are both on ${version}. Nothing to update.`);
    return 0;
  }
  if ((wantClient && clientBehind) || (wantServer && serverBehind)) {
    deps.out(`Updating to ${version}`);
    deps.out('');
  }

  let code = 0;
  let clientDone = false;
  if (wantClient) {
    if (deps.appVersion === 'dev') {
      deps.out('This machine: a development checkout. Update it with git pull.');
    } else if (!clientBehind) {
      deps.out(`This machine: ${bare(deps.appVersion)} is current.`);
      clientDone = true;
    } else {
      deps.out(`This machine: ${bare(deps.appVersion)} → ${version}`);
      try {
        await deps.installClient(latest);
        deps.out('  Installed. It takes effect the next time you open phantom-cli.');
        clientDone = true;
      } catch (event) {
        deps.out(`  The update failed: ${errorText(event)}`);
        code = 1;
      }
    }
    if (wantServer) deps.out('');
  }

  if (wantServer) {
    if (!deps.server) {
      deps.out('Server: none paired. Open phantom-cli and pair one on /server.');
      return target === 'server' ? 1 : code;
    }
    if (!serverVersion) {
      deps.out(`Server: unreachable (${deps.server.url}).`);
      return 1;
    }
    if (!serverBehind) {
      deps.out(`Server: ${serverVersion} is current.`);
    } else {
      deps.out(`Server: ${serverVersion} → ${version}`);
      const loopsRunning = health?.loops_running ?? 0;
      if (loopsRunning > 0) {
        deps.out(loopsRunning === 1
          ? '  1 card is being worked on right now. Restarting the server will stop it and mark it blocked.'
          : `  ${loopsRunning} cards are being worked on right now. Restarting the server will stop them and mark them blocked.`);
        if (!await deps.confirm('  Continue? [y/N] ')) {
          deps.out('  Server not updated.');
          return code;
        }
      }
      // Stream pull progress, then wait for the restart to land.
      const outcome = await streamUpdateProgress(deps, deps.server, latest);
      if (outcome === 'error') return 1;
      // The server sent "restarting" — wait for it to come back on the new version.
      deps.out('');
      const reached = await waitForVersion(deps, deps.server, version);
      if (!reached.ok) {
        deps.out(`  Waited ${minutes(deps.timeoutMs ?? TIMEOUT_MS)} and the server still reports ${reached.last ?? serverVersion}. The update did not finish.`);
        deps.out('  Log in to the server and run: docker logs phantom-update-run');
        return 1;
      }
      deps.out(`  Server is on ${version}.`);
    }
  }

  if (target === 'both' && clientDone && code === 0) {
    deps.out('');
    deps.out(`Done. Both are on ${version}.`);
  }
  return code;
}

/** `phantom-cli --version`: this machine, and the server when one is paired. */
export function versionLines(app: string, server: { url: string; version: string | null } | null): string[] {
  const lines = [`This machine: ${bare(app)}`];
  if (server) lines.push(`Server:       ${server.version ? bare(server.version) : 'unreachable'}  (${server.url})`);
  return lines;
}

/** The notice printed at quit, or null when nothing is behind. `latest` is the
 *  latest published release (null offline); `server` the paired server's
 *  version (null when unreachable or unpaired). A dev checkout is never
 *  behind, so from a checkout only the server half can be named. `installed`
 *  is the version a background auto-update put in place this run (autoUpdate.ts)
 *  — this machine is then done, and only the server can still be behind. */
export function quitNotice(app: string, server: string | null, latest: string | null, installed: string | null = null): string | null {
  const clientBehind = latest ? isBehind(app, latest) : false;
  const serverBehind = latest && server ? isBehind(server, latest) : false;
  if (installed) {
    const ready = `phantom-cli v${installed} is ready — runs next launch`;
    if (serverBehind) return `${ready}\nVersion ${bare(latest!)} is available. The server is on ${bare(server!)}.\nRun: phantom-cli update --server`;
    return ready;
  }
  if (latest && (clientBehind || serverBehind)) {
    const version = bare(latest);
    const a = bare(app);
    const serverVersion = server ? bare(server) : null;
    if (clientBehind && serverBehind) {
      const have = a === serverVersion
        ? `You have ${a} on this machine and on the server.`
        : `You have ${a} on this machine and ${serverVersion} on the server.`;
      return `Version ${version} is available. ${have}\nRun: phantom-cli update`;
    }
    if (clientBehind) return `Version ${version} is available. This machine is on ${a}.\nRun: phantom-cli update --client`;
    return `Version ${version} is available. The server is on ${serverVersion}.\nRun: phantom-cli update --server`;
  }
  if (server && isBehind(app, server)) {
    return `The server is on ${bare(server)}. This machine is on ${bare(app)}.\nRun: phantom-cli update --client`;
  }
  return null;
}
