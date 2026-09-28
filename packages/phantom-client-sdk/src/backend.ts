// The one way the SDK reaches a phantom-backend. A `PhantomBackend` owns the
// address, the key, this client's lock identity, and the transport (`fetch`
// — real HTTP, or whatever the app injects). Every request goes through it:
// the headers are written in one place, the envelope is read in one place,
// a streaming body is read in one place.
//
// Every route answers the same envelope: { ok:true, data } or
// { ok:false, error:{ code, message, retryable } }. `call` unwraps it and
// throws a PhantomError with the server's code when it is one of ours.
//
// `withRetry(policy, notice)` answers a second client on the same connection
// whose fetch retries transport failures and 5xx — the Agent makes one for
// its own calls and keeps the plain one for best-effort work (the live relay),
// where a minute of retries would only serve stale output.
import { PhantomError, ERROR_CODES, type ErrorCode } from './errors.js';
import { withRetry as retryingFetch, type RetryPolicy } from './model/retry.js';

export interface BackendOptions {
  /** The API root, e.g. `http://localhost:4000/api`. */
  url: string;
  apiKey: string;
  /** This client's lock identity — sent as x-phantom-looper-client. */
  clientId: string;
  /** What other clients see as the session's holder (a hostname, an app
   *  name). Defaults to clientId. */
  label?: string;
  fetch?: typeof fetch;
}

export const SESSION_HEADER = 'x-phantom-looper-session';
export const CLIENT_HEADER = 'x-phantom-looper-client';

export interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string; retryable?: boolean };
}

export interface CallOptions {
  /** Sent as the session header. */
  sessionId?: string;
  signal?: AbortSignal;
}

const isErrorCode = (s: unknown): s is ErrorCode =>
  typeof s === 'string' && (ERROR_CODES as readonly string[]).includes(s);

/** Server codes that name the same customer situation as one of ours. */
const SERVER_CODES: Record<string, ErrorCode> = { agent_config_invalid: 'config_invalid' };

/** One JSON record per line off a streaming body. A torn last line is
 *  dropped; a line that is not JSON is skipped. */
export async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { yield JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    }
  }
}

export class PhantomBackend {
  readonly url: string;
  readonly clientId: string;
  readonly label: string;
  readonly #apiKey: string;
  readonly #fetch: typeof fetch;

  constructor(o: BackendOptions) {
    this.url = o.url;
    this.clientId = o.clientId;
    this.label = o.label ?? o.clientId;
    this.#apiKey = o.apiKey;
    this.#fetch = o.fetch ?? fetch;
  }

  /** The same connection, every request retried on a network failure or a
   *  retryable status per `policy`; each attempt reported through `notice`. */
  withRetry(policy: RetryPolicy, notice: (text: string) => void): PhantomBackend {
    return new PhantomBackend({ url: this.url, apiKey: this.#apiKey, clientId: this.clientId, label: this.label,
      fetch: retryingFetch(this.#fetch, notice, 'server', policy) });
  }

  /** The headers every request carries: the API key, this client's lock
   *  identity, the session when the call is on behalf of one, and
   *  content-type ONLY with a body (Fastify 400s a bodyless request that
   *  claims application/json). */
  #headers(opts: { sessionId?: string; body?: boolean }): Record<string, string> {
    return {
      authorization: `Bearer ${this.#apiKey}`,
      [CLIENT_HEADER]: this.clientId,
      ...(opts.sessionId ? { [SESSION_HEADER]: opts.sessionId } : {}),
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
    };
  }

  /** One request. Only transport failures throw. */
  async #request(method: string, path: string, body: unknown, opts: CallOptions): Promise<Response> {
    try {
      return await this.#fetch(`${this.url}${path}`, {
        method, headers: this.#headers({ sessionId: opts.sessionId, body: body !== undefined }),
        body: body === undefined ? undefined : JSON.stringify(body), signal: opts.signal,
      });
    } catch (e) {
      throw new PhantomError('backend_error', `${method} ${path}: ${(e as Error).message}`, { cause: e, retryable: true });
    }
  }

  /** One API call, unwrapped. Resolves with `data`; throws a PhantomError —
   *  with the server's code when it is one of ours. */
  async call<T = unknown>(method: string, path: string, body?: unknown, opts: CallOptions = {}): Promise<T> {
    const r = await this.#request(method, path, body, opts);
    const j = await this.#envelope<T>(r, method, path);
    if (!j.ok) {
      const code = j.error?.code;
      const message = `${method} ${path}: ${code ?? r.status} ${j.error?.message ?? ''}`.trim();
      const ours = isErrorCode(code) ? code : (code && SERVER_CODES[code]) || 'backend_error';
      throw new PhantomError(ours, message, { retryable: j.error?.retryable ?? false });
    }
    return j.data as T;
  }

  /** The raw envelope, for callers that want the server's refusal AS DATA
   *  (a tool handing `{ok:false, error}` to the model). Only transport
   *  failures throw. */
  async callRaw<T = unknown>(method: string, path: string, body?: unknown, opts: CallOptions = {}): Promise<Envelope<T>> {
    const r = await this.#request(method, path, body, opts);
    return this.#envelope<T>(r, method, path);
  }

  /** A route that answers ND-JSON, one record at a time, until the server
   *  closes it or `signal` aborts. A refusal (an envelope instead of a
   *  stream) throws with the server's code. */
  async *stream(method: string, path: string, body?: unknown, opts: CallOptions = {}): AsyncGenerator<Record<string, unknown>> {
    const r = await this.#request(method, path, body, opts);
    if ((r.headers.get('content-type') ?? '').includes('application/json')) {
      const j = await this.#envelope(r, method, path);
      const code = j.error?.code;
      throw new PhantomError(isErrorCode(code) ? code : 'backend_error',
        `${method} ${path}: ${j.error?.message ?? `HTTP ${r.status}`}`, { retryable: j.error?.retryable ?? false });
    }
    if (!r.ok || !r.body) throw new PhantomError('backend_error', `${method} ${path}: HTTP ${r.status} with no stream`);
    yield* ndjson(r.body);
  }

  async #envelope<T>(r: Response, method: string, path: string): Promise<Envelope<T>> {
    try {
      return await r.json() as Envelope<T>;
    } catch (e) {
      throw new PhantomError('backend_error', `${method} ${path}: HTTP ${r.status}, not JSON`, { cause: e });
    }
  }
}
