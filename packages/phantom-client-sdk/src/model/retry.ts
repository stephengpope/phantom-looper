// THE retry loop — a fetch wrapper, so it works identically for every
// provider and every kind of call. The AI SDK's own loop is a fixed 2s
// doubling with no way to shape it, so every AI SDK call sets maxRetries: 0
// and this is the one loop. Retryable failures (429/408/409/5xx and network
// errors) wait out RETRY_WAITS_S and try again, reporting each attempt as a
// notice. Fatal statuses (400/401/403/404) return at once for the SDK to
// throw. Aborting cancels a wait immediately. A non-replayable body
// (streaming upload) is never retried.

/** A retry schedule: the waits between attempts, and a ceiling on the total
 *  time spent waiting. Both are the client's to set (Agent options). */
export interface RetryPolicy {
  /** Seconds between attempts; the list's length is the attempt cap. */
  waitsS: readonly number[];
  /** Hard ceiling on TOTAL time spent waiting, ms. */
  budgetMs: number;
  /** Which HTTP statuses are worth another try. */
  retryable: (status: number) => boolean;
}

/** Model APIs: providers rate-limit and overload for real. Totals 164s of
 *  waits under a 3-minute ceiling — inside the session lock's TTL. 409 is a
 *  transient conflict there. */
export const MODEL_RETRY: RetryPolicy = {
  waitsS: [2, 4, 8, 15, 30, 45, 60],
  budgetMs: 180_000,
  retryable: (s) => s === 408 || s === 409 || s === 429 || s >= 500,
};
/** The phantom-backend: local or one hop away — if it cannot answer in
 *  ~15s, waiting longer helps nobody. 409 means "locked" or "conflict": a
 *  fact, never retried. */
export const BACKEND_RETRY: RetryPolicy = {
  waitsS: [1, 2, 4, 8],
  budgetMs: 15_000,
  retryable: (s) => s === 408 || s === 429 || s >= 500,
};

/** Kept for callers that only want the model schedule's numbers. */
export const RETRY_WAITS_S = MODEL_RETRY.waitsS;
export const RETRY_BUDGET_MS = MODEL_RETRY.budgetMs;

/** retry-after, when the server sent one: used if it asks for MORE than our
 *  scheduled wait, capped at 60s — the budget check still has the last word. */
function serverDelayMs(r: Response, scheduledMs: number): number {
  const h = r.headers.get('retry-after-ms') ?? r.headers.get('retry-after');
  if (!h) return scheduledMs;
  const n = parseFloat(h);
  const ms = r.headers.get('retry-after-ms') ? n
    : Number.isNaN(n) ? Date.parse(h) - Date.now() : n * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return scheduledMs;
  return Math.min(60_000, Math.max(scheduledMs, ms));
}

const wait = (ms: number, signal?: AbortSignal | null) => new Promise<void>((res, rej) => {
  const onAbort = () => { clearTimeout(t); rej(signal?.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError')); };
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); res(); }, ms);
  if (signal?.aborted) { onAbort(); return; }
  signal?.addEventListener('abort', onAbort, { once: true });
});

export function withRetry(inner: typeof fetch | undefined, notice: (text: string) => void,
  policy: RetryPolicy = MODEL_RETRY): typeof fetch {
  const f = inner ?? fetch;
  const { waitsS, budgetMs, retryable } = policy;
  return async (input, init) => {
    const replayable = init?.body == null || typeof init.body === 'string';
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      let r: Response | undefined;
      let netErr: unknown;
      try {
        r = await f(input, init);
      } catch (e) {
        // Only a genuine network failure retries — fetch rejects those as
        // TypeError ('fetch failed'). Aborts and everything else rethrow.
        if (!(e instanceof TypeError)) throw e;
        netErr = e;
      }
      if (r && !retryable(r.status)) return r;

      const what = netErr ? `model unreachable (${(netErr as Error).message})`
        : r!.status === 429 ? 'model answered 429 (rate limited)'
        : r!.status === 529 ? 'model answered 529 (overloaded)'
        : `model answered ${r!.status}`;
      const scheduled = waitsS[attempt];
      const delayMs = scheduled === undefined ? undefined
        : r ? serverDelayMs(r, scheduled * 1000) : scheduled * 1000;
      if (!replayable || delayMs === undefined || waited + delayMs > budgetMs) {
        notice(`${what} — giving up after ${attempt} ${attempt === 1 ? 'retry' : 'retries'}`);
        if (netErr) throw netErr as Error;
        return r!;
      }
      notice(`${what} — retry ${attempt + 1}/${waitsS.length} in ${Math.round(delayMs / 1000)}s`);
      waited += delayMs;
      await wait(delayMs, init?.signal);
    }
  };
}
