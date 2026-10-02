// THE CONNECTION POLICY for the bot's outbound calls (Deepgram, Telegram's
// file store) — the same one the cli's sidecar runs (bot.py, "Deepgram: the
// connection policy"); a change here is a change there:
//  - a connect that gets no answer fails at CONNECT_TIMEOUT_MS. api.deepgram.com
//    rotates between sites and a site can go dead from a given network
//    (github.com/orgs/deepgram/discussions/764); a normal connect is 20–50 ms.
//  - a FAILED CONNECTION is retried once, fresh DNS (Deepgram rotates the
//    name within the minute, so the retry can land elsewhere). A SLOW ANSWER
//    is never cut: pre-recorded transcription can take 20 s+ under load, and
//    a cap would throw the voice note away.
//  - keep-alive: Deepgram closes an idle connection at 5 s (measured
//    2026-09-04: reused at 4.8 s, new socket at 5 s). KEEP_ALIVE_MS sits under
//    that so we never send on a socket the far end already closed.

// undici's OWN fetch, not Node's global: Node bundles a different undici
// (7.x under Node 24) and refuses an Agent built by the package's 8.x
// ("invalid onRequestStart method"). The pair must come from one place.
import { Agent, fetch } from 'undici';

/** Give up on a connection that has not answered in this long. */
export const CONNECT_TIMEOUT_MS = 2000;
/** Retries after a failed CONNECTION — never after a slow answer. */
export const CONNECT_RETRIES = 1;
/** Hold an idle connection this long — under Deepgram's 5 s idle close. */
export const KEEP_ALIVE_MS = 4000;

const agent = new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS }, keepAliveTimeout: KEEP_ALIVE_MS });

/** A connection-level failure: never reached the far end, or lost it before
 *  a response. Anything else — a 4xx/5xx, a body that fails to parse — is
 *  the far end's answer and is not retried. */
export function isConnectFailure(e: unknown): boolean {
  const code = String((e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code ?? '');
  return /^(UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_SOCKET)$/.test(code);
}

/** fetch under the policy: through the agent, a failed connection retried
 *  once. Throws what fetch throws when the retry fails too. */
export async function connectFetch(url: string, init: Parameters<typeof fetch>[1] = {}): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(url, { ...init, dispatcher: agent }) as unknown as Response;
    } catch (e) {
      if (attempt < CONNECT_RETRIES && isConnectFailure(e)) continue;
      throw e;
    }
  }
}
