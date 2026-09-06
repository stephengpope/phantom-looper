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
// The server half waits: POST /update returns as soon as the tag is handed to
// the updater sidecar, and the observable result is GET /health's version
// changing (the api restarts in between and is unreachable for a moment —
// those polls just miss). A restart cuts off every loop round in flight and
// blocks those cards, so `loops_running` from /health gates a confirmation.
//
// Everything reaches this module through `deps`, so update.test.ts scripts a
// release, a server and a clock without a network or a terminal.
import { isBehind } from './selfUpdate.js';

export type Target = 'both' | 'client' | 'server';

export interface ServerLink {
  url: string;
  call(method: string, path: string, body?: unknown): Promise<unknown>;
}

export interface UpdateDeps {
  /** APP_VERSION — '0.1.2', or 'dev' from a checkout. */
  appVersion: string;
  /** The latest published release tag ('v0.1.3'), null when GitHub is unreachable. */
  latest(): Promise<string | null>;
  /** The paired server, or null when nothing is paired. */
  server: ServerLink | null;
  /** selfUpdate(tag) — download, verify, unpack, re-link. */
  installClient(tag: string): Promise<unknown>;
  /** Ask the person a yes/no question. */
  confirm(question: string): Promise<boolean>;
  /** Print one line. */
  out(line: string): void;
  /** Rewrite the current line — the ticking wait. Absent: ticks are not shown. */
  tick?(line: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  pollMs?: number;
  timeoutMs?: number;
}

export const POLL_MS = 3_000;
export const TIMEOUT_MS = 180_000;

/** 'v0.1.3' → '0.1.3'. */
export function bare(v: string): string { return v.replace(/^v/, ''); }

interface Health { version?: string; loops_running?: number }

async function readHealth(server: ServerLink): Promise<Health | null> {
  try { return await server.call('GET', '/health') as Health; } catch { return null; }
}

function errorText(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/** 72000 → '1m 12s'; 9000 → '9s'. */
export function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function minutes(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60_000));
  return m === 1 ? '1 minute' : `${m} minutes`;
}

/** Poll /health until it reports `version`, or the timeout passes. */
async function waitForVersion(d: UpdateDeps, server: ServerLink, version: string):
  Promise<{ ok: true; ms: number } | { ok: false; last: string | null }> {
  const start = d.now();
  const timeout = d.timeoutMs ?? TIMEOUT_MS;
  let last: string | null = null;
  for (;;) {
    const ms = d.now() - start;
    if (ms >= timeout) return { ok: false, last };
    d.tick?.(`  Waiting... ${elapsed(ms)}`);
    await d.sleep(d.pollMs ?? POLL_MS);
    const h = await readHealth(server);
    if (h?.version) {
      last = bare(String(h.version));
      if (last === version) return { ok: true, ms: d.now() - start };
    }
  }
}

/** The command. Returns the process exit code. */
export async function runUpdate(target: Target, d: UpdateDeps): Promise<number> {
  const latest = await d.latest();
  if (!latest) { d.out('Could not reach GitHub to find the latest release.'); return 1; }
  const v = bare(latest);
  const wantClient = target !== 'server';
  const wantServer = target !== 'client';

  const health = wantServer && d.server ? await readHealth(d.server) : null;
  const serverVersion = health?.version ? bare(String(health.version)) : null;
  const clientBehind = isBehind(d.appVersion, latest);
  const serverBehind = serverVersion ? isBehind(serverVersion, latest) : false;

  if (target === 'both' && serverVersion && d.appVersion !== 'dev' && !clientBehind && !serverBehind) {
    d.out(`This machine and the server are both on ${v}. Nothing to update.`);
    return 0;
  }
  if ((wantClient && clientBehind) || (wantServer && serverBehind)) {
    d.out(`Updating to ${v}`);
    d.out('');
  }

  let code = 0;
  let clientDone = false;
  if (wantClient) {
    if (d.appVersion === 'dev') {
      d.out('This machine: a development checkout. Update it with git pull.');
    } else if (!clientBehind) {
      d.out(`This machine: ${bare(d.appVersion)} is current.`);
      clientDone = true;
    } else {
      d.out(`This machine: ${bare(d.appVersion)} → ${v}`);
      try {
        await d.installClient(latest);
        d.out('  Installed. It takes effect the next time you open phantom-cli.');
        clientDone = true;
      } catch (e) {
        d.out(`  The update failed: ${errorText(e)}`);
        code = 1;
      }
    }
    if (wantServer) d.out('');
  }

  if (wantServer) {
    if (!d.server) {
      d.out('Server: none paired. Open phantom-cli and pair one on /server.');
      return target === 'server' ? 1 : code;
    }
    if (!serverVersion) {
      d.out(`Server: unreachable (${d.server.url}).`);
      return 1;
    }
    if (!serverBehind) {
      d.out(`Server: ${serverVersion} is current.`);
    } else {
      d.out(`Server: ${serverVersion} → ${v}`);
      const n = health?.loops_running ?? 0;
      if (n > 0) {
        d.out(n === 1
          ? '  1 card is being worked on right now. Restarting the server will stop it and mark it blocked.'
          : `  ${n} cards are being worked on right now. Restarting the server will stop them and mark them blocked.`);
        if (!await d.confirm('  Continue? [y/N] ')) {
          d.out('  Server not updated.');
          return code;
        }
      }
      try {
        await d.server.call('POST', '/update', { tag: latest });
      } catch (e) {
        d.out(`  The update could not be requested: ${errorText(e)}`);
        return 1;
      }
      d.out('  The server is downloading the update and restarting. Sessions pause for about a minute.');
      const r = await waitForVersion(d, d.server, v);
      if (!r.ok) {
        d.out(`  Waited ${minutes(d.timeoutMs ?? TIMEOUT_MS)} and the server still reports ${r.last ?? serverVersion}. The update did not finish.`);
        d.out('  Log in to the server and run: docker logs phantom-update-run');
        return 1;
      }
      d.out(`  Waiting... ${elapsed(r.ms)}`);
      d.out(`  Server is on ${v}.`);
    }
  }

  if (target === 'both' && clientDone && code === 0) {
    d.out('');
    d.out(`Done. Both are on ${v}.`);
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
 *  behind, so from a checkout only the server half can be named. */
export function quitNotice(app: string, server: string | null, latest: string | null): string | null {
  const clientBehind = latest ? isBehind(app, latest) : false;
  const serverBehind = latest && server ? isBehind(server, latest) : false;
  if (latest && (clientBehind || serverBehind)) {
    const v = bare(latest);
    const a = bare(app);
    const s = server ? bare(server) : null;
    if (clientBehind && serverBehind) {
      const have = a === s
        ? `You have ${a} on this machine and on the server.`
        : `You have ${a} on this machine and ${s} on the server.`;
      return `Version ${v} is available. ${have}\nRun: phantom-cli update`;
    }
    if (clientBehind) return `Version ${v} is available. This machine is on ${a}.\nRun: phantom-cli update --client`;
    return `Version ${v} is available. The server is on ${s}.\nRun: phantom-cli update --server`;
  }
  if (server && isBehind(app, server)) {
    return `The server is on ${bare(server)}. This machine is on ${bare(app)}.\nRun: phantom-cli update --client`;
  }
  return null;
}
