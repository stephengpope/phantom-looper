// The one way the SDK reaches a phantom-backend. A `BackendClient` owns the
// address, the key, this client's lock identity, and the transport (`fetch`
// — real HTTP, or whatever the app injects). Every request goes through it:
// the headers are written in one place, the envelope is read in one place,
// a streaming body is read in one place.
//
// Every route answers the same envelope: { ok:true, data } or
// { ok:false, error:{ code, message, retryable } }. `call` unwraps it and
// throws a PhantomError with the server's code when it is one of ours.
//
// A network failure or a retryable status is retried per `retry` (the
// policy the Agent sets from its handlers), each attempt a notice. A call
// that must not wait — best-effort live output — says `retry: false`; a
// stream is never retried (a live feed is not replayed).
import { PhantomError } from './errors.js';
import { withRetry as retryingFetch, type RetryPolicy } from './model/retry.js';
import { SDK_VERSION } from './sdkVersion.js';
import { Identity, credentialHeaders, type Caller } from './identity.js';
import { Media } from './media.js';

/** What a client carries: the service role key (every SDK route), a user's
 *  session token (a sign-in's `set-auth-token`), or a user role key. */
export type Credential = { serviceRoleKey: string } | { sessionToken: string } | { userRoleKey: string };

export interface BackendOptions {
  /** The API root, e.g. `http://localhost:4000/api`. */
  url: string;
  credential: Credential;
  /** This client's lock identity — sent as x-phantom-client. */
  clientId: string;
  /** What other clients see as the session's holder (a hostname, an app
   *  name). Defaults to clientId. */
  label?: string;
  /** WHO this client acts for — the automation's name (a cron, a card run,
   *  a bot); unsaid = a person. Sent as x-phantom-actor: the backend
   *  records it as a session's `started_by` and `last_turn_by`. */
  actor?: string;
  /** With the service role key: the organization (and optionally the user, a
   *  member of it) every call is for. The backend runs each call as them —
   *  their organization's rows only, their keys first — and records them
   *  as who made what. Sent as x-phantom-organization / x-phantom-user.
   *  Ignored with a user's own credential, which already says who. */
  actingFor?: { organizationId: string; userId?: string };
  fetch?: typeof fetch;
  /** How a failed request is retried. Absent = never. */
  retry?: { policy: RetryPolicy; notice: (text: string) => void };
}

const SESSION_HEADER = 'x-phantom-session';
const CLIENT_HEADER = 'x-phantom-client';
const ACTOR_HEADER = 'x-phantom-actor';
const ACTING_ORGANIZATION_HEADER = 'x-phantom-organization';
const ACTING_USER_HEADER = 'x-phantom-user';
/** Who acts when a client says nothing (no actor): a person. Every
 *  automation names itself. The backend records it as a session's
 *  `started_by` (who opened it) and `last_turn_by` (who drove it last). */
export const PERSON = 'person';

/** What every route answers. */
export type Envelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; retryable: boolean; detail?: unknown } };

export interface CallOptions {
  /** Sent as the session header. */
  sessionId?: string;
  signal?: AbortSignal;
  /** false: this request is never retried (best-effort work). */
  retry?: boolean;
}

/** The server's refusal as the error the app reads: the server's code,
 *  message and status, exactly as sent — the message is the sentence a
 *  person reads; the request it answers is in `cause`. */
const refused = (refusal: { code: string; message: string; retryable: boolean }, status: number, what: string): PhantomError =>
  new PhantomError(refusal.code, refusal.message, { retryable: refusal.retryable, status, cause: new Error(`${what} answered ${status} ${refusal.code}`) });

/** One JSON record per line off a streaming body. A torn last line is
 *  dropped; a line that is not JSON is skipped. */
async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let newlineAt: number;
    while ((newlineAt = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, newlineAt).trim();
      buf = buf.slice(newlineAt + 1);
      if (!line) continue;
      try { yield JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    }
  }
}

export class BackendClient {
  readonly url: string;
  readonly clientId: string;
  readonly label: string;
  readonly actor: string | undefined;
  /** With the service role key: the organization and user every call is for (BackendOptions.actingFor). */
  readonly actingFor: BackendOptions['actingFor'];
  /** Who this client acts for, as the backend records it: the actor, or a person. */
  get actorName(): string { return this.actor ?? PERSON; }
  #credential: Credential;
  /** Sign-in: who am I, and Better Auth's client. */
  readonly identity: Identity;
  /** Tracked files on the backend's S3-compatible storage. */
  readonly media: Media;
  readonly #fetch: typeof fetch;
  readonly #retrying: typeof fetch;
  /** The lockstep check, made once per connection on the first request;
   *  a clone (withRetry) shares its parent's. */
  #versionChecked: Promise<void> | null = null;

  constructor(options: BackendOptions) {
    this.url = options.url;
    this.clientId = options.clientId;
    this.label = options.label ?? options.clientId;
    this.actor = options.actor;
    this.actingFor = options.actingFor;
    this.#credential = options.credential;
    this.#fetch = options.fetch ?? fetch;
    this.#retrying = options.retry ? retryingFetch(this.#fetch, options.retry.notice, 'server', options.retry.policy) : this.#fetch;
    this.identity = new Identity({
      origin: new URL(this.url).origin, fetch: this.#fetch,
      credential: () => this.#credential,
      onSessionToken: (sessionToken) => { this.#credential = { sessionToken }; },
      me: () => this.call<Caller>('GET', '/identity/me'),
    });
    this.media = new Media(this);
  }

  /** The same connection with a retry rule — the Agent's, from its handlers. */
  withRetry(policy: RetryPolicy, notice: (text: string) => void): BackendClient {
    const clone = new BackendClient({ url: this.url, credential: this.#credential, clientId: this.clientId, label: this.label, actor: this.actor, actingFor: this.actingFor,
      fetch: this.#fetch, retry: { policy, notice } });
    clone.#versionChecked = this.#versionChecked;
    return clone;
  }

  /** The lockstep rule: client and backend SDK are one version. GET /health
   *  carries the backend's; a mismatch refuses every request with
   *  `sdk_version_mismatch`. Asked once per connection (its clones share
   *  the answer); a check that could not reach the server is not an
   *  answer — the next request asks again, and reports its own failure. */
  connect(): Promise<void> {
    if (!this.#versionChecked) {
      this.#versionChecked = this.#checkVersion().catch((error) => { this.#versionChecked = null; throw error; });
    }
    return this.#versionChecked;
  }

  async #checkVersion(): Promise<void> {
    const response = await this.#request('GET', '/health', undefined, { retry: false }, true);
    if (!response.ok) throw new PhantomError('bad_response', `GET /health: HTTP ${response.status}`, { status: response.status });
    const health = await response.json() as { sdk_version?: string };
    if (health.sdk_version !== SDK_VERSION) {
      throw new PhantomError('sdk_version_mismatch',
        `this client runs @phantom-agent-sdk/client ${SDK_VERSION}; the backend runs @phantom-agent-sdk/backend ${health.sdk_version ?? '(unversioned)'} — the two must be one version`);
    }
  }

  /** The headers every request carries: the credential, this client's lock
   *  identity, the session when the call is on behalf of one, and
   *  content-type ONLY with a body (Fastify 400s a bodyless request that
   *  claims application/json). */
  #headers(opts: { sessionId?: string; contentType?: string }): Record<string, string> {
    return {
      ...credentialHeaders(this.#credential),
      [CLIENT_HEADER]: this.clientId,
      ...(this.actor ? { [ACTOR_HEADER]: this.actor } : {}),
      ...(this.actingFor ? { [ACTING_ORGANIZATION_HEADER]: this.actingFor.organizationId,
        ...(this.actingFor.userId ? { [ACTING_USER_HEADER]: this.actingFor.userId } : {}) } : {}),
      ...(opts.sessionId ? { [SESSION_HEADER]: opts.sessionId } : {}),
      ...(opts.contentType ? { 'content-type': opts.contentType } : {}),
    };
  }

  /** One request, after the lockstep check (`connecting` IS the check's
   *  own request). A body is JSON unless it comes as `raw` bytes with
   *  their own content type. Only transport failures throw. */
  async #request(method: string, path: string, body: unknown, opts: CallOptions, connecting = false,
    raw?: { body: BodyInit; contentType: string }): Promise<Response> {
    if (!connecting) await this.connect();
    // A streamed body is sent once: never retried.
    const fetchWith = opts.retry === false || raw ? this.#fetch : this.#retrying;
    const contentType = raw ? raw.contentType : body !== undefined ? 'application/json' : undefined;
    try {
      // A path under /app is user space's, at the API's origin; any other is the SDK's, under the API root.
      return await fetchWith(path.startsWith('/app/') ? new URL(path, this.url).toString() : `${this.url}${path}`, {
        method, headers: this.#headers({ sessionId: opts.sessionId, contentType }),
        body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body), signal: opts.signal,
        // fetch sends a stream body only when told it is one-way.
        ...(raw && raw.body instanceof ReadableStream ? { duplex: 'half' } : {}),
      });
    } catch (error) {
      throw new PhantomError('unreachable', `${method} ${path}: ${(error as Error).message}`, { cause: error, retryable: true });
    }
  }

  /** One API call whose body is bytes (a file), unwrapped like `call`. */
  async callBytes<T = unknown>(method: string, path: string, body: BodyInit, contentType: string, opts: CallOptions = {}): Promise<T> {
    const response = await this.#request(method, path, undefined, opts, false, { body, contentType });
    const j = await this.#envelope<T>(response, method, path);
    if (!j.ok) throw refused(j.error, response.status, `${method} ${path}`);
    return j.data;
  }

  /** One API call, unwrapped. Resolves with `data`; throws a PhantomError —
   *  with the server's code when it is one of ours. */
  async call<T = unknown>(method: string, path: string, body?: unknown, opts: CallOptions = {}): Promise<T> {
    const response = await this.#request(method, path, body, opts);
    const j = await this.#envelope<T>(response, method, path);
    if (!j.ok) throw refused(j.error, response.status, `${method} ${path}`);
    return j.data;
  }

  /** The raw envelope, for callers that want the server's refusal AS DATA
   *  (a tool handing `{ok:false, error}` to the model). Only transport
   *  failures throw. */
  async callRaw<T = unknown>(method: string, path: string, body?: unknown, opts: CallOptions = {}): Promise<Envelope<T>> {
    const response = await this.#request(method, path, body, opts);
    return this.#envelope<T>(response, method, path);
  }

  /** A route that answers ND-JSON, one record at a time, until the server
   *  closes it or `signal` aborts. A refusal (an envelope instead of a
   *  stream) throws with the server's code. */
  async *stream(method: string, path: string, body?: unknown, opts: CallOptions = {}): AsyncGenerator<Record<string, unknown>> {
    const response = await this.#request(method, path, body, { ...opts, retry: false });
    if ((response.headers.get('content-type') ?? '').includes('application/json')) {
      const j = await this.#envelope(response, method, path);
      throw j.ok ? new PhantomError('not_a_stream', `${method} ${path}: answered data, not a stream`, { status: response.status })
        : refused(j.error, response.status, `${method} ${path}`);
    }
    if (!response.ok || !response.body) throw new PhantomError('bad_response', `${method} ${path}: HTTP ${response.status} with no stream`, { status: response.status });
    yield* ndjson(response.body);
  }

  async #envelope<T>(response: Response, method: string, path: string): Promise<Envelope<T>> {
    try {
      return await response.json() as Envelope<T>;
    } catch (error) {
      throw new PhantomError('bad_response', `${method} ${path}: HTTP ${response.status}, not JSON`, { cause: error, status: response.status });
    }
  }
}
