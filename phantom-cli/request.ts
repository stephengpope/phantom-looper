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

