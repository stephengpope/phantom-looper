// The one place a failed request to phantom-backend becomes a sentence.
//
// Every screen that shows an error shows THIS message behind its own
// "could not <do what> in <where>:" — nothing else in the app inspects a raw
// error, and "server down" reads the same way everywhere. Lives apart from
// index.tsx (the entrypoint has side effects) so it can be tested.

/** Three shapes:
 *    - the network failed: "phantom-backend at <url> is not reachable"
 *    - the key was refused: "… rejected the key — /server to fix it"
 *    - the server refused: the server's own sentence (its code rides as
 *      `.code` for the few callers that branch on one). */
export function requestError(method: string, path: string, base: string, cause: unknown,
  refusal?: { status: number; code?: string; message?: string }): Error & { code?: string; status?: number } {
  let text: string;
  let code: string | undefined;
  if (refusal) {
    code = refusal.code;
    if (refusal.status === 401 || refusal.code === 'unauthorized') {
      text = `phantom-backend at ${base} rejected the key — /server to fix it`;
    } else {
      text = refusal.message || `phantom-backend at ${base} answered ${method} ${path} with HTTP ${refusal.status} and no message`;
    }
  } else {
    const c = cause as { cause?: { code?: string; message?: string }; message?: string; name?: string };
    const why = c?.cause?.code ?? c?.cause?.message ?? (c?.name === 'SyntaxError' ? 'not a phantom-backend reply' : c?.message);
    text = `phantom-backend at ${base} is not reachable${why ? ` (${why})` : ''}`;
    code = 'unreachable';
  }
  const failed = new Error(text) as Error & { code?: string; status?: number };
  if (code) failed.code = code;
  if (refusal) failed.status = refusal.status;
  return failed;
}

/** The request path's answer to the feed's reconnect. A feed that drops and
 *  comes back assumes it missed things and refills from the record; ordinary
 *  requests had no equivalent — each failure was handled locally and nothing
 *  ever noticed the server was healthy again, so state poisoned during an
 *  outage stayed poisoned until a relaunch. This wrapper is that notice:
 *  every call passes through it, and the FIRST success after a failure fires
 *  onRecover, once per outage.
 *
 *  "Down" means the server could not do its job: unreachable, or a 5xx (it
 *  answered but failed — a full disk reads exactly like this). A functional
 *  refusal (400/401/404/409 — wrong key, session locked) is the server
 *  working, and never arms recovery.
 *
 *  The wrapper changes nothing a caller sees: same result, same throw. A
 *  recovery whose own calls fail (the server still flapping) re-arms
 *  itself — the failures mark it down again and the next success refires. */
export function watchConnection(api: Api, onRecover: () => Promise<void> | void): Api {
  let down = false;
  let recovering = false;
  let again = false;
  const fire = async (): Promise<void> => {
    if (recovering) { again = true; return; }   // asked to refire mid-recovery: run once more after
    recovering = true;
    try {
      do { again = false; await onRecover(); } while (again);
    } catch (e) {
      console.warn(`background: recovery after an outage failed: ${(e as Error).message ?? String(e)}`);
    } finally { recovering = false; }
  };
  return async (method, path, body) => {
    try {
      const r = await api(method, path, body);
      if (down) { down = false; void fire(); }
      return r;
    } catch (e) {
      const err = e as { code?: string; status?: number };
      if (err.code === 'unreachable' || (err.status ?? 0) >= 500) down = true;
      throw e;
    }
  };
}

/** The window's one call into phantom-backend. index.tsx builds the real one
 *  (it reads the connection per request); every screen and store takes it as
 *  `api`. Declared here, beside the error it throws, so the type and the
 *  sentence have one home. */
export type Api = (method: string, path: string, body?: unknown) => Promise<unknown>;

/** The ONLY quiet failure the app allows: background work that runs again on
 *  its own (a list refresh, a lock release at quit) goes to cli.log with what
 *  it was doing — never to the pane, never nowhere. Everything a person asked
 *  for fails out loud with `could not <do what>: <why>`. */
export const quiet = (doing: string) => (e: unknown): void => {
  console.warn(`background: could not ${doing}: ${(e as Error).message ?? String(e)}`);
};
