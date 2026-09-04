// The looper (and the turn route) are headless CLIENTS of this server's own
// HTTP surface — same routes, same envelope, same locks as
// the cli. In-process that transport is Fastify's inject: no port to know, no
// network, and every hook and schema still runs. This shim gives the core
// kits (which speak fetch) that transport.
import type { FastifyInstance } from 'fastify';

export function injectFetch(app: FastifyInstance): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url, 'http://looper');
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
    // A content-type with NO body makes Fastify's JSON parser reject the
    // request (the empty-body 400) — over real HTTP the header is simply
    // meaningless without a body, so drop it to match.
    if (init?.body === undefined) delete headers['content-type'];
    const r = await app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: u.pathname + u.search,
      headers,
      ...(init?.body !== undefined ? { payload: init.body as string } : {}),
    });
    return new Response(r.body, {
      status: r.statusCode,
      headers: r.headers as Record<string, string>,
    });
  }) as typeof fetch;
}
