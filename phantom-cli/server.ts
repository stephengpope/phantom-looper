// The window's one connection to the server. One HTTP/2 socket
// (`BackendConnection`) carries every call, feed and turn; `BackendClient`
// puts the headers on, reads the envelope, hands back streams. Every request
// this window makes — the agents', the screens', the kits' — goes through
// here, with this window's lock identity and label.
//
// The address and key are read from the local settings file at every
// request, never captured: /server rewrites the file while the app runs, and
// the next call must reach the new address with the new key. A move rebuilds
// the socket; a server on its own CA (setup-backend saved its root) is
// trusted through the saved certificate.
//
// The server is always https behind Caddy — dev included — so this is the one
// transport; any other URL is a setup error, said in the error.
import { rootCertificates } from 'node:tls';
import { BackendClient, BackendConnection, isPhantomError } from '@phantom-agent-sdk/client';
import { localValues } from './local.js';
import { savedCaFor } from './provision.js';
import { requestError, type Api } from './request.js';

export class Server {
  #connection: BackendConnection | null = null;
  #backend: BackendClient | null = null;
  #base: string | null = null;

  constructor(readonly clientId: string, readonly label: string) {}

  /** The address and key as the file has them now. */
  static connection(): { base: string; key: string } {
    const local = localValues();
    return { base: String(local.server_url ?? ''), key: String(local.server_key ?? '') };
  }

  /** The backend for the address in the file right now — rebuilt when the
   *  address moved. Throws when nothing is paired or the URL is not https. */
  backend(): BackendClient {
    const { base, key } = Server.connection();
    if (!base) throw new Error('no phantom-backend paired — setup-backend, or /server to enter one');
    const origin = new URL(base).origin;
    if (!origin.startsWith('https:')) throw new Error(`phantom-backend URL must be https:// (got ${base}) — /server to fix it, or scripts/setup.sh for a dev box`);
    if (this.#backend && this.#base === base) return this.#backend;
    this.#connection?.close();
    const savedCa = savedCaFor(base);
    this.#connection = new BackendConnection({ origin, ...(savedCa ? { certificateAuthority: [...rootCertificates, savedCa] } : {}) });
    this.#backend = new BackendClient({ url: `${base}/api`, credential: { operatorKey: key }, clientId: this.clientId, label: this.label, fetch: this.#connection.fetch });
    this.#base = base;
    return this.#backend;
  }

  /** One call, the envelope unwrapped; a failure is the cli's sentence
   *  (request.ts) with the server's code and status on it. */
  api: Api = async (method, path, body) => {
    const { base } = Server.connection();
    try { return await this.backend().call(method, path, body); }
    catch (error) { throw isPhantomError(error) ? requestError(method, path, base, error) : error; }
  };

  /** A server stream (ND-JSON) as records — the board's live feed. Open
   *  until the signal aborts or the server hangs up. */
  async stream(path: string, signal: AbortSignal): Promise<AsyncIterable<Record<string, unknown>>> {
    const { base } = Server.connection();
    const records = this.backend().stream('GET', path, undefined, { signal });
    // The refusal, if any, comes with the first read: surface it as the
    // cli's sentence before anyone iterates.
    const first = await records.next().catch((error: unknown) => { throw isPhantomError(error) ? requestError('GET', path, base, error) : error; });
    return (async function* () {
      if (!first.done) yield first.value;
      yield* records;
    })();
  }

  /** POST /git/auto-push or /git/auto-pull for one session, under this
   *  window's identity: every `step` record becomes a line for the pane,
   *  the one `result` record is the answer; heartbeats fall through. */
  async git<T extends { result: string }>(route: 'auto-push' | 'auto-pull', sessionId: string,
    steps: Record<string, string>, onStep?: (label: string) => void): Promise<T> {
    const { base } = Server.connection();
    let result: T | undefined;
    try {
      for await (const rec of this.backend().stream('POST', `/git/${route}`, {}, { sessionId })) {
        // `detail` is the part the step name cannot say — the conflicted
        // files, the round, a commit-message retry as it happens.
        if (rec.event === 'step' && typeof rec.step === 'string') {
          const detail = typeof rec.detail === 'string' && rec.detail ? ` — ${rec.detail}` : '';
          onStep?.(`${steps[rec.step] ?? rec.step}${detail}`);
        } else if (rec.event === 'result') {
          const { event: _event, ...rest } = rec;
          result = { result: 'error', ...rest } as unknown as T;
        }
      }
    } catch (error) { throw isPhantomError(error) ? requestError('POST', `/git/${route}`, base, error) : error; }
    if (!result) throw new Error(`phantom-backend ended the ${route} stream without a result — the server log has the reason`);
    return result;
  }
}
