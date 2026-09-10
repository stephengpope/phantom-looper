// Auto-update: about once a day the cli checks for a new release and, when
// the auto_update setting is on, installs it in the background. The install
// is selfUpdate's — checksum-verified, unpacked beside the running version,
// ONE symlink moved — so the running process is never touched: the new
// version is next launch's, and the prompt's version label swaps to say so
// ("v0.1.4 is ready — runs next launch") until then. auto_update off: no
// install, and the quit-time notice offers `phantom-cli update` as before.
//
// "Once a day" for a cli whose sessions run for minutes is a stamp, not a
// timer: a launch checks only when the last check is a day old, and a window
// that stays open re-asks on the same gate. The stamp is the app's
// bookkeeping, so it lives in settings.json (last_update_check) — a key the
// settings writer preserves but never shows (local.ts), not a setting a
// person sets.
//
// Two open windows can both pass the gate and download the same release.
// The checksum makes the bytes identical and the symlink move is the whole
// switch, so the worst case is a wasted download — accepted, rather than a
// lock file that a killed window could leave behind (which would silently
// stop updates on that machine for good).
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG_PATH } from './config.js';
import { readOverrides, setBookkeeping } from './local.js';
import { bare, isBehind } from '../core/version.js';
import { logLine } from './cliLog.js';
import { readHealth, runUpdate, type UpdateDeps } from './update.js';

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const STAMP_KEY = 'last_update_check';

/** Is it time to check again? No stamp — or an unreadable one — means due. */
export function dueForCheck(now: number, path = CONFIG_PATH): boolean {
  const t = Number(readOverrides(path).overrides[STAMP_KEY]);
  return !Number.isFinite(t) || t <= 0 || now - t >= CHECK_INTERVAL_MS;
}

/** Record the check BEFORE it runs: a failed attempt retries tomorrow, not
 *  on every launch. Also sweeps the side file the first version of this used
 *  — one check per machine, then it is gone for good. */
export function stampChecked(now: number, path = CONFIG_PATH): void {
  setBookkeeping(STAMP_KEY, now, path);
  const legacy = join(dirname(path), 'last-update-check');
  if (existsSync(legacy)) rmSync(legacy, { force: true });
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
// Every launch brings BOTH halves to the latest release before the app opens,
// through the ONE update flow: runUpdate (update.ts), the same code
// `phantom-cli update` runs — the client half first (automatic — nothing
// restarts but this process), then the server half (it RESTARTS the server,
// so cards in flight gate a confirmation; a yes carries restart_anyway past
// the server's own guard). No session is open yet, so nothing is interrupted
// and no lock is ever taken by a build that is about to be replaced.
//
// The target is ALWAYS the latest published release: a version mismatch
// (from /health) forces the GitHub check, and the daily stamp gates it when
// the versions agree, so ordinary launches never wait on the network. When
// the client half landed, the gate re-execs into it — the "next launch" the
// install message names is this one.
//
// A declined or failed step opens the app anyway — runUpdate has already
// named what happened, and the quit notice names what is still behind.
// Unreachable server, nothing paired, a dev checkout: no gate at all (the
// background cycle above still keeps an unpaired client current).

/** The gate's health read must never hold a launch hostage: a server that
 *  accepts the connection and says nothing costs this much, then no gate. */
export const HEALTH_TIMEOUT_MS = 5_000;

export interface ReconcileDeps extends UpdateDeps {
  /** Hand the terminal to the installed build of `version` and exit. */
  reexec(version: string): void;
  /** The settings file the stamp lives in — the test seam, CONFIG_PATH in
   *  production. */
  settingsPath?: string;
}

export async function prelaunchReconcile(d: ReconcileDeps): Promise<void> {
  if (d.appVersion === 'dev' || !d.server) return;
  const h = await Promise.race([
    readHealth(d.server),
    d.sleep(HEALTH_TIMEOUT_MS).then(() => null),
  ]);
  if (!h?.version) return;   // unreachable is its own, louder failure in the app
  const server = bare(String(h.version));
  const me = bare(d.appVersion);

  // In line and checked recently: open without touching the network. A
  // mismatch is itself the news that something released, stamp or no stamp.
  if (me === server && !dueForCheck(d.now(), d.settingsPath)) return;
  const latest = await d.latest();
  stampChecked(d.now(), d.settingsPath);
  if (!latest) {
    if (me !== server) {
      d.out(`The server is on v${server}, this machine is on v${me}, and GitHub cannot be reached to find the latest release — opening as-is.`);
    }
    return;
  }
  const target = bare(latest);
  const clientBehind = isBehind(me, target);
  if (!clientBehind && !isBehind(server, target)) return;

  // The ONE update flow. Two wraps: latest() replays the tag just fetched
  // (one GitHub call, not two), and installClient records a landing so the
  // gate knows whether there is a new build to re-exec into.
  let installed: string | null = null;
  await runUpdate('both', {
    ...d,
    latest: async () => latest,
    installClient: async (tag) => { await d.installClient(tag); installed = bare(tag); },
  });
  if (installed) d.reexec(installed);
}
