// ND-JSON off a response body, one parsed record at a time — the server's
// stream shape (auto-push, auto-pull, command logs, the board's events). Read
// by the cli and by the headless kits alike. A line that is not JSON is
// skipped; the generator ends when the body does.
export async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { yield JSON.parse(line) as Record<string, unknown>; } catch { /* not a record */ }
    }
    if (done) return;
  }
}
