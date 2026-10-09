// One connection to the server, for everything. An HTTP/2 session carries
// every call, every live feed and every turn as streams on one socket — no
// connection per feed, no connection per burst of requests, no handshake on
// the first request after a quiet spell. The session reconnects on its own
// when the socket drops; a request that finds it closed opens a new one.
//
// `fetch` is what it speaks — what `BackendClient` takes — so nothing above
// this file knows the transport. Node's own fetch could not be made to
// negotiate HTTP/2 reliably; `node:http2` does it directly.
import http2, { type ClientHttp2Session, type OutgoingHttpHeaders } from 'node:http2';
import { Readable } from 'node:stream';

export interface BackendConnectionOptions {
  /** The server's origin, e.g. `https://phantom.example.com`. */
  origin: string;
  /** Extra root certificates to trust (a server on its own CA). */
  certificateAuthority?: string | Buffer | Array<string | Buffer>;
}

export class BackendConnection {
  readonly origin: string;
  readonly #certificateAuthority: BackendConnectionOptions['certificateAuthority'];
  #session: ClientHttp2Session | null = null;

  constructor(options: BackendConnectionOptions) {
    this.origin = options.origin;
    this.#certificateAuthority = options.certificateAuthority;
    this.fetch = this.fetch.bind(this);
  }

  /** The open session, or a new one when the last one closed. */
  #connect(): ClientHttp2Session {
    if (this.#session && !this.#session.closed && !this.#session.destroyed) return this.#session;
    const session = http2.connect(this.origin, this.#certificateAuthority ? { ca: this.#certificateAuthority } : {});
    session.on('error', () => undefined);   // surfaces on the streams that were open
    session.on('close', () => { if (this.#session === session) this.#session = null; });
    this.#session = session;
    return session;
  }

  /** Hang up. The next request reconnects. */
  close(): void { this.#session?.close(); this.#session = null; }

  /** Tear the socket down NOW: every request on it fails at once, and the
   *  next one opens a fresh connection. For a link that went silent — a
   *  dead TCP connection errors on its own only when the OS gives up on it,
   *  minutes later, and nothing sent in between ever arrives. */
  destroy(): void { this.#session?.destroy(); this.#session = null; }

  /** A request on the connection, as a `fetch`. Any other origin falls
   *  through to the platform fetch. */
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== this.origin) return globalThis.fetch(input, init);

    const headers: OutgoingHttpHeaders = { ':method': init?.method ?? 'GET', ':path': url.pathname + url.search };
    new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
    const body = init?.body;
    // A request with no body says so: without the length the proxy in front
    // of the server forwards an empty chunked body, which the server reads
    // as a body with no content type (415) — proven on turn-ended.
    if (body === undefined || body === null) headers['content-length'] = 0;
    const req = this.#connect().request(headers);
    const signal = init?.signal;

    // Settles the way the platform fetch does, so a caller can never be left
    // waiting: cancelled → rejects at once with the signal's reason (and the
    // stream is reset, so the server stops); the stream gone before an answer
    // → rejects with fetch's own TypeError("fetch failed"), which is what
    // the retry policy reads as a network failure.
    return new Promise<Response>((resolve, reject) => {
      let answered = false;
      const onAbort = () => {
        req.close(http2.constants.NGHTTP2_CANCEL);
        if (!answered) reject(abortReason(signal!));
      };
      const failed = (cause: unknown) => {
        if (answered) return;
        reject(signal?.aborted ? abortReason(signal) : new TypeError('fetch failed', { cause }));
      };
      if (signal?.aborted) { onAbort(); return; }
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => {
        signal?.removeEventListener('abort', onAbort);
        failed(new Error(`stream closed before an answer (code ${req.rstCode})`));
      });
      req.on('error', failed);
      req.on('response', (responseHeaders) => {
        answered = true;
        const status = Number(responseHeaders[':status'] ?? 0);
        const out = new Headers();
        for (const [name, value] of Object.entries(responseHeaders)) if (!name.startsWith(':') && value !== undefined) out.set(name, Array.isArray(value) ? value.join(', ') : String(value));
        const stream = Readable.toWeb(req) as ReadableStream<Uint8Array>;
        resolve(new Response(status === 204 ? null : stream, { status, headers: out }));
      });
      if (body === undefined || body === null) req.end();
      else if (typeof body === 'string' || body instanceof Uint8Array) req.end(body);
      else { answered = true; req.close(http2.constants.NGHTTP2_CANCEL); reject(new TypeError('BackendConnection: only string or bytes bodies are supported')); }
    });
  }
}

/** What a cancelled request rejects with: the signal's reason, as fetch does. */
const abortReason = (signal: AbortSignal): Error =>
  signal.reason instanceof Error ? signal.reason : new DOMException('This operation was aborted', 'AbortError');
