// The session's in-flight FOREGROUND commands, so the stop signal can kill
// them. A unary bash runs setsid'd with its pgid in a pidfile (see the bash
// tool in routes/fs.ts); this map is pidfile → sandbox per session. The fs
// route registers on spawn and removes on exit; POST /sessions/:id/interrupt
// kills everything listed.
//
// Why a registry and not the request's abort: a cli's esc aborts the tool
// fetch and the socket close fires the kill in the route — but a stop from
// another client (/stop on Telegram, the interrupt route) has no socket of
// the turn's to close. The interrupt route is the one place every stop path
// crosses, so the kill hangs off it: tell the turn to stop AND kill what it
// was running, whoever ran the turn.
// Detached commands are not here by design — detached means "keep running".
import { logger, errStr } from '../lib/log.js';
import type { Sandbox } from '../runtime/Sandbox.js';

const log = logger('bash');

/** Kill one process tree, sid read from the pidfile the bash wrapper wrote —
 *  one exec, the read and the kill in a single script. A second exec is the
 *  only kill Docker offers (the Engine API has no exec-kill, moby#9098) and
 *  an exec'd command is a session leader (runc setsids it), so the sid names
 *  the whole tree and `pkill -s` reaches children. TERM, ~1s grace, KILL.
 *  The pidfile can lag the exec's spawn by a beat, so the read retries. */
export function killProcessGroup(sandbox: Sandbox, pidfile: string): Promise<unknown> {
  const script =
    'sid=""; for i in 1 2 3 4 5; do sid=$(cat "$0" 2>/dev/null) && [ -n "$sid" ] && break; sleep 0.2; done; ' +
    '[ -n "$sid" ] || exit 0; ' +
    'pkill -TERM -s "$sid" 2>/dev/null; sleep 1; ' +
    'pgrep -s "$sid" >/dev/null 2>&1 && pkill -KILL -s "$sid" 2>/dev/null; ' +
    'rm -f "$0"; exit 0';
  return sandbox.run(['/bin/sh', '-c', script, pidfile], { timeoutMs: 15_000 })
    .catch((error) => log.warn({ err: errStr(error) }, 'kill of command group failed'));
}

/** pidfile → sandbox, per session. Entries are added before the command's
 *  exec starts and removed when it ends for any reason, so a kill never
 *  names a finished command's reused pidfile. */
export class ForegroundCommands {
  private bySession = new Map<string, Map<string, Sandbox>>();

  add(sessionId: string, pidfile: string, sandbox: Sandbox): void {
    let pidfiles = this.bySession.get(sessionId);
    if (!pidfiles) this.bySession.set(sessionId, (pidfiles = new Map()));
    pidfiles.set(pidfile, sandbox);
  }

  remove(sessionId: string, pidfile: string): void {
    const pidfiles = this.bySession.get(sessionId);
    if (!pidfiles) return;
    pidfiles.delete(pidfile);
    if (!pidfiles.size) this.bySession.delete(sessionId);
  }

  /** How many foreground commands these sessions have in flight right now
   *  — zero is the SAFE STATE a move waits for: between two tool calls. */
  inFlight(sessionIds: Iterable<string>): number {
    let n = 0;
    for (const id of sessionIds) n += this.bySession.get(id)?.size ?? 0;
    return n;
  }

  /** TERM-then-KILL every foreground command the session has in flight.
   *  Fire-and-forget like the disconnect kill: the kill ends the exec, which
   *  resolves the tool call on its own. Idempotent — pkill of a dead session
   *  is a no-op, so doubling with the socket-close kill is harmless. */
  killAll(sessionId: string): void {
    for (const [pidfile, sandbox] of this.bySession.get(sessionId) ?? []) {
      void killProcessGroup(sandbox, pidfile);
    }
  }
}
