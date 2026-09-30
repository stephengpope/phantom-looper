// One connection to the server, for everything. An HTTP/2 session carries
// every call, every live feed and every turn as streams on one socket — no
// connection per feed, no connection per burst of requests, no handshake on
// the first request after a quiet spell. The session reconnects on its own
// when the socket drops; a request that finds it closed opens a new one.
//
// `fetch` is what it speaks — what `PhantomBackend` takes — so nothing above
// this file knows the transport. Node's own fetch could not be made to
// negotiate HTTP/2 reliably; `node:http2` does it directly.
import http2, { type ClientHttp2Session, type OutgoingHttpHeaders } from 'node:http2';
import { Readable } from 'node:stream';

export interface ServerConnectionOptions {
  /** The server's origin, e.g. `https://phantom.example.com`. */
  origin: string;
  /** Extra root certificates to trust (a server on its own CA). */
  ca?: string | Buffer | Array<string | Buffer>;
}

export class ServerConnection {
  readonly origin: string;
  readonly #ca: ServerConnectionOptions['ca'];
  #session: ClientHttp2Session | null = null;

  constructor(o: ServerConnectionOptions) {
    this.origin = o.origin;
    this.#ca = o.ca;
    this.fetch = this.fetch.bind(this);
  }

  /** The open session, or a new one when the last one closed. */
  #connect(): ClientHttp2Session {
    if (this.#session && !this.#session.closed && !this.#session.destroyed) return this.#session;
    const s = http2.connect(this.origin, this.#ca ? { ca: this.#ca } : {});
    s.on('error', () => undefined);   // surfaces on the streams that were open
    s.on('close', () => { if (this.#session === s) this.#session = null; });
    this.#session = s;
    return s;
  }

  /** Hang up. The next request reconnects. */
  close(): void { this.#session?.close(); this.#session = null; }

  /** A request on the connection, as a `fetch`. Any other origin falls
   *  through to the platform fetch. */
  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== this.origin) return globalThis.fetch(input, init);

    const headers: OutgoingHttpHeaders = { ':method': init?.method ?? 'GET', ':path': url.pathname + url.search };
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    const body = init?.body;
    const req = this.#connect().request(headers);
    const signal = init?.signal;
    const onAbort = () => req.close(http2.constants.NGHTTP2_CANCEL);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });

    return new Promise<Response>((resolve, reject) => {
      req.on('error', (e: Error) => {
        signal?.removeEventListener('abort', onAbort);
        const reason: unknown = signal?.aborted ? signal.reason : undefined;
        reject(reason instanceof Error ? reason : e);
      });
      req.on('response', (h) => {
        const status = Number(h[':status'] ?? 0);
        const out = new Headers();
        for (const [k, v] of Object.entries(h)) if (!k.startsWith(':') && v !== undefined) out.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        const stream = Readable.toWeb(req) as ReadableStream<Uint8Array>;
        req.on('close', () => signal?.removeEventListener('abort', onAbort));
        resolve(new Response(status === 204 ? null : stream, { status, headers: out }));
      });
      if (body === undefined || body === null) req.end();
      else if (typeof body === 'string' || body instanceof Uint8Array) req.end(body);
      else reject(new TypeError('ServerConnection: only string or bytes bodies are supported'));
    });
  }
}
