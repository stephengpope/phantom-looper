// Auto-update: about once a day the cli checks for a new release and, when
// the auto_update setting is on, installs it in the background. The install
// is selfUpdate's — checksum-verified, unpacked beside the running version,
// ONE symlink moved — so the running process is never touched: the new
// version is next launch's, and the prompt's version label swaps to say so
// ("v0.1.4 is ready — runs next launch") until then. auto_update off: no
// install, and the quit-time notice offers `phantom-cli update` as before.
//
// "Once a day" for a cli whose sessions run for minutes is a stamp file, not
// a timer: a launch checks only when the last check is a day old, and a
// window that stays open re-asks on the same gate. The stamp is bookkeeping,
// not a choice, which is why it is NOT in settings.json — that file holds
// only what a person changed (config.ts's one rule).
//
// Two open windows can both pass the gate and download the same release.
// The checksum makes the bytes identical and the symlink move is the whole
// switch, so the worst case is a wasted download — accepted, rather than a
// lock file that a killed window could leave behind (which would silently
// stop updates on that machine for good).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_DIR } from './config.js';
import { bare, isBehind } from '../core/version.js';
import { logLine } from './cliLog.js';
import { readHealth, waitForVersion, TIMEOUT_MS, type ServerLink } from './update.js';

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const stampPath = (dir: string): string => join(dir, 'last-update-check');

/** Is it time to check again? No stamp — or an unreadable one — means due. */
export function dueForCheck(now: number, dir = CONFIG_DIR): boolean {
  try {
    const t = Number(readFileSync(stampPath(dir), 'utf8').trim());
    return !Number.isFinite(t) || now - t >= CHECK_INTERVAL_MS;
  } catch { return true; }
}

/** Record the check BEFORE it runs: a failed attempt retries tomorrow, not
 *  on every launch. Best-effort — a failed write just means the next launch
 *  checks again. */
export function stampChecked(now: number, dir = CONFIG_DIR): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(stampPath(dir), String(now));
  } catch { /* the next launch checks again */ }
}

export interface AutoUpdateDeps {
  /** APP_VERSION — 'dev' is never behind and never installs. */
  appVersion: string;
  /** The auto_update setting, resolved (read fresh each cycle). */
  autoUpdate: boolean;
  /** The latest published release tag, null when unreachable. */
  latest(): Promise<string | null>;
  /** selfUpdate(tag) — download, verify, unpack, re-link. */
  install(tag: string): Promise<unknown>;
}

export interface CycleResult {
  /** The latest published release (null offline) — the quit notice reads it. */
  latest: string | null;
  /** The version installed this cycle, when one was. */
  installed: string | null;
}

/** One cycle: check, and install when behind and allowed. Never throws — a
 *  failed install is logged to cli.log and retried next cycle, never shown:
 *  the person did not ask for this, so its errors are not their news. */
export async function autoUpdateCycle(d: AutoUpdateDeps): Promise<CycleResult> {
  const latest = await d.latest();
  if (!latest || d.appVersion === 'dev' || !isBehind(d.appVersion, latest)) {
    return { latest, installed: null };
  }
  if (!d.autoUpdate) return { latest, installed: null };
  try {
    await d.install(latest);
    return { latest, installed: bare(latest) };
  } catch (e) {
    logLine(`auto-update to ${latest} failed: ${e instanceof Error ? e.message : String(e)}`);
    return { latest, installed: null };
  }
}

// ── the launch gate ─────────────────────────────────────────────────────────
// Every launch compares this machine and the paired server BEFORE the app
// opens, and brings the two in line right there — no session is open yet, so
// nothing is interrupted and no lock is ever taken by a build that is about
// to be replaced:
//
//   server newer → install the SERVER'S exact tag and re-exec into it. The
//     target is the server's tag, never latest: catching up must not
//     overshoot into a version the server does not have.
//   cli newer    → the fix is a server update, which RESTARTS the server —
//     so it is always confirmed: one y/N naming the versions (and the cards
//     being worked on, when there are any; a yes then carries
//     restart_anyway). A yes is followed by a ticking wait for the server to
//     come back on the new version.
//
// A declined or failed reconcile opens the app anyway, mismatched — the quit
// notice names what is behind. Unreachable server, nothing paired, a dev
// checkout: no gate at all.

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface ReconcileDeps {
  /** APP_VERSION — 'dev' skips the gate. */
  appVersion: string;
  /** The paired server, or null when nothing is paired. */
  server: ServerLink | null;
  /** selfUpdate(tag) — download, verify, unpack, re-link. */
  install(tag: string): Promise<unknown>;
  /** Ask the person a yes/no question. */
  confirm(question: string): Promise<boolean>;
  /** Print one line. */
  out(line: string): void;
  /** Hand the terminal to the installed build of `version` and exit. */
  reexec(version: string): void;
  /** Rewrite the current line — the ticking wait. Absent: no ticks. */
  tick?(line: string): void;
  sleep(ms: number): Promise<void>;
  now(): number;
  pollMs?: number;
  timeoutMs?: number;
}

export async function prelaunchReconcile(d: ReconcileDeps): Promise<void> {
  if (d.appVersion === 'dev' || !d.server) return;
  const h = await readHealth(d.server);
  if (!h?.version) return;   // unreachable is its own, louder failure in the app
  const server = bare(String(h.version));
  const me = bare(d.appVersion);

  if (isBehind(me, server)) {
    d.out(`The server is on v${server}, this machine is on v${me} — updating this machine to match.`);
    try {
      await d.install(`v${server}`);
    } catch (e) {
      d.out(`The update failed: ${errText(e)} — opening anyway.`);
      return;
    }
    d.reexec(server);
    return;
  }

  if (isBehind(server, me)) {
    const n = h.loops_running ?? 0;
    const q = n > 0
      ? `The server is on v${server}, this machine is on v${me}. Updating the server restarts it and stops the ${n === 1 ? '1 card' : `${n} cards`} being worked on. Update now? [y/N] `
      : `The server is on v${server}, this machine is on v${me}. Update the server now? It restarts — about a minute. [y/N] `;
    if (!await d.confirm(q)) {
      d.out('Left as-is — the versions differ; phantom-cli update brings them in line.');
      return;
    }
    try {
      await d.server.call('POST', '/update', { tag: `v${me}`, restart_anyway: true });
    } catch (e) {
      d.out(`The update could not be requested: ${errText(e)} — opening anyway.`);
      return;
    }
    const r = await waitForVersion(d, d.server, me);
    if (r.ok) {
      d.out(`The server is on v${me}.`);
    } else {
      d.out(`Waited ${Math.max(1, Math.round((d.timeoutMs ?? TIMEOUT_MS) / 60_000))} minutes and the server still reports ${r.last ?? server} — opening anyway.`);
      d.out('If it never comes back, on the server run: docker logs phantom-update-run');
    }
  }
}
