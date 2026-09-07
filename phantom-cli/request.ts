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
  refusal?: { status: number; code?: string; message?: string }): Error & { code?: string } {
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
  const failed = new Error(text) as Error & { code?: string };
  if (code) failed.code = code;
  return failed;
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
