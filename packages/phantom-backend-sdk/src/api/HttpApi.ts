// HttpApi — the HTTP surface: Fastify, one bearer key on every route, the
// envelope ({ok, data} / {ok:false, error:{code,message,retryable}}),
// every SDK route, the OpenAPI document, and the door user space adds
// routes through. Stub.
import type { RouteRegistrar } from '../doors.js';

export class HttpApi {
  /** Register user space's routes, after the SDK's, under the same auth. */
  addRoutes(registrar: RouteRegistrar): void { throw stub(); }
  async listen(port: number, host?: string): Promise<{ url: string }> { throw stub(); }
  async close(): Promise<void> { throw stub(); }
  /** The envelope helpers, for user space's routes. */
  static ok<T>(data: T): { ok: true; data: T } { throw stub(); }
  static error(code: string, message: string, retryable?: boolean, detail?: unknown): { ok: false; error: { code: string; message: string; retryable: boolean; detail?: unknown } } { throw stub(); }
}
const stub = () => new Error('stub');
