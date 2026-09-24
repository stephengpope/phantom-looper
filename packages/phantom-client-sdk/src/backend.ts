// The one way the SDK reaches a phantom-backend. Local or remote is only
// the `fetch`: the server hands its in-process shim, everyone else the real
// one. Every call carries the API key and this client's lock identity; a
// call on behalf of a session carries the session header too.
//
// Every route answers the same envelope: { ok:true, data } or
// { ok:false, error:{ code, message, retryable } }. `call` unwraps it and
// throws a PhantomError with the server's code when it is one of ours.
import { PhantomError, ERROR_CODES, type ErrorCode } from './errors.js';

export interface PhantomBackend {
  /** The API root, e.g. `http://localhost:4000/api`. */
  url: string;
  apiKey: string;
  /** This client's lock identity — sent as x-phantom-looper-client. */
  clientId: string;
  fetch?: typeof fetch;
  /** Can this fetch read a response as it streams? Real HTTP can; the
   *  server's in-process shim buffers whole bodies and must say false —
   *  the SDK then does not open the session feed (it would never end). */
  canStream?: boolean;
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

/** One API call, unwrapped. Resolves with `data`; throws a PhantomError. */
export async function call<T = unknown>(
  b: PhantomBackend, method: string, path: string, body?: unknown, opts: CallOptions = {},
): Promise<T> {
  const f = b.fetch ?? fetch;
  const headers: Record<string, string> = {
    authorization: `Bearer ${b.apiKey}`,
    [CLIENT_HEADER]: b.clientId,
    ...(opts.sessionId ? { [SESSION_HEADER]: opts.sessionId } : {}),
    // content-type ONLY with a body: Fastify 400s a bodyless request that
    // claims application/json.
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  };
  let r: Response;
  try {
    r = await f(`${b.url}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: opts.signal,
    });
  } catch (e) {
    throw new PhantomError('backend_error', `${method} ${path}: ${(e as Error).message}`, { cause: e, retryable: true });
  }
  let j: Envelope<T>;
  try {
    j = await r.json() as Envelope<T>;
  } catch (e) {
    throw new PhantomError('backend_error', `${method} ${path}: HTTP ${r.status}, not JSON`, { cause: e });
  }
  if (!j.ok) {
    const code = j.error?.code;
    const message = `${method} ${path}: ${code ?? r.status} ${j.error?.message ?? ''}`.trim();
    throw new PhantomError(isErrorCode(code) ? code : 'backend_error', message,
      { retryable: j.error?.retryable ?? false });
  }
  return j.data as T;
}

/** The raw envelope, for callers that want the server's refusal AS DATA
 *  (a tool handing `{ok:false, error}` to the model). Only transport
 *  failures throw. */
export async function callRaw<T = unknown>(
  b: PhantomBackend, method: string, path: string, body?: unknown, opts: CallOptions = {},
): Promise<Envelope<T>> {
  const f = b.fetch ?? fetch;
  const headers: Record<string, string> = {
    authorization: `Bearer ${b.apiKey}`,
    [CLIENT_HEADER]: b.clientId,
    ...(opts.sessionId ? { [SESSION_HEADER]: opts.sessionId } : {}),
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
  };
  let r: Response;
  try {
    r = await f(`${b.url}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: opts.signal,
    });
  } catch (e) {
    throw new PhantomError('backend_error', `${method} ${path}: ${(e as Error).message}`, { cause: e, retryable: true });
  }
  try {
    return await r.json() as Envelope<T>;
  } catch (e) {
    throw new PhantomError('backend_error', `${method} ${path}: HTTP ${r.status}, not JSON`, { cause: e });
  }
}
