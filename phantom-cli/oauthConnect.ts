// The cli's half of connecting an OAuth secret: open the provider's page in
// the user's browser and catch the redirect it sends back. The server does
// everything else (the URL, the code exchange, the tokens — SDK
// oauth/OAuthSecrets.ts); this side only has to be where the browser is.
//
// The redirect is caught on a fixed loopback port (OAUTH_REDIRECT_URI, the
// server's constant: `http://localhost:53682/callback` — rclone's convention):
// most providers require the exact registered URI, so the user registers this
// one once and it never changes. A port already taken is reported as such.
import http from 'node:http';
import { spawn } from 'node:child_process';

/** How long the browser gets before the connect is abandoned. */
const TIMEOUT_MS = 5 * 60_000;

/** Open `url` in the system browser; resolves when the command was launched. */
export function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url.replace(/&/g, '^&')]]
    : ['xdg-open', [url]];
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.on('error', () => undefined); // no browser: the url is on screen too
  child.unref();
}

/** Listen on the redirect's port until the provider sends the browser back;
 *  resolves with the FULL URL it arrived on (code and state in its query),
 *  which is what the server's callback route takes. The browser is shown a
 *  short page either way; `signal` abandons the wait. */
export function catchRedirect(redirectUri: string, signal?: AbortSignal): Promise<string> {
  const target = new URL(redirectUri);
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', target.origin);
      if (url.pathname !== target.pathname) { res.writeHead(404).end(); return; }
      const error = url.searchParams.get('error');
      const page = (text: string) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><title>phantom-looper</title><body style="font:16px system-ui;padding:3rem;text-align:center">${text}<br><br>You can close this tab.</body>`);
      };
      if (error) { page(`The provider refused: ${error}.`); finish(() => reject(new Error(`the provider refused: ${url.searchParams.get('error_description') ?? error}`))); return; }
      page('Connected to phantom-looper.');
      finish(() => resolve(url.toString()));
    });
    const timer = setTimeout(() => finish(() => reject(new Error('the browser never came back — connect again'))), TIMEOUT_MS);
    const abort = () => finish(() => reject(new Error('connect cancelled')));
    signal?.addEventListener('abort', abort, { once: true });
    function finish(settle: () => void) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      server.close();
      settle();
    }
    server.on('error', (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(error.code === 'EADDRINUSE'
        ? new Error(`port ${target.port} is in use on this machine — free it, then connect again`)
        : error);
    });
    server.listen(Number(target.port), '127.0.0.1');
  });
}
