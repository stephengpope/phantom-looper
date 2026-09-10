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
