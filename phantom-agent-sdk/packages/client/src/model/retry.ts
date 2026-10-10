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
  retryable: (status) => status === 408 || status === 409 || status === 429 || status >= 500,
};
/** The phantom-backend: local or one hop away — if it cannot answer in
 *  ~15s, waiting longer helps nobody. 409 means "locked" or "conflict": a
 *  fact, never retried. */
export const BACKEND_RETRY: RetryPolicy = {
  waitsS: [1, 2, 4, 8],
  budgetMs: 15_000,
  retryable: (status) => status === 408 || status === 429 || status >= 500,
};

/** retry-after, when the server sent one: used if it asks for MORE than our
 *  scheduled wait, capped at 60s — the budget check still has the last word. */
function serverDelayMs(response: Response, scheduledMs: number): number {
  const retryAfter = response.headers.get('retry-after-ms') ?? response.headers.get('retry-after');
  if (!retryAfter) return scheduledMs;
  const parsed = parseFloat(retryAfter);
  const delayMs = response.headers.get('retry-after-ms') ? parsed
    : Number.isNaN(parsed) ? Date.parse(retryAfter) - Date.now() : parsed * 1000;
  if (!Number.isFinite(delayMs) || delayMs <= 0) return scheduledMs;
  return Math.min(60_000, Math.max(scheduledMs, delayMs));
}

const wait = (delayMs: number, signal?: AbortSignal | null) => new Promise<void>((res, rej) => {
  const onAbort = () => { clearTimeout(timer); rej(signal?.reason instanceof Error ? signal.reason : new DOMException('aborted', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); res(); }, delayMs);
  if (signal?.aborted) { onAbort(); return; }
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** `who` names the other end in the notices: 'model' or 'server'. */
export function withRetry(inner: typeof fetch | undefined, notice: (text: string) => void,
  who: 'model' | 'server', policy: RetryPolicy = MODEL_RETRY): typeof fetch {
  const fetchWith = inner ?? fetch;
  const { waitsS, budgetMs, retryable } = policy;
  return async (input, init) => {
    const replayable = init?.body == null || typeof init.body === 'string';
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined;
      let netErr: unknown;
      try {
        response = await fetchWith(input, init);
      } catch (error) {
        // Only a genuine network failure retries — fetch rejects those as
        // TypeError ('fetch failed'). Aborts and everything else rethrow.
        if (!(error instanceof TypeError)) throw error;
        netErr = error;
      }
      if (response && !retryable(response.status)) return response;

      const what = netErr ? `${who} unreachable (${(netErr as Error).message})`
        : response!.status === 429 ? `${who} answered 429 (rate limited)`
        : response!.status === 529 ? `${who} answered 529 (overloaded)`
        : `${who} answered ${response!.status}`;
      const scheduled = waitsS[attempt];
      const delayMs = scheduled === undefined ? undefined
        : response ? serverDelayMs(response, scheduled * 1000) : scheduled * 1000;
      if (!replayable || delayMs === undefined || waited + delayMs > budgetMs) {
        notice(`${what} — giving up after ${attempt} ${attempt === 1 ? 'retry' : 'retries'}`);
        if (netErr) throw netErr as Error;
        return response!;
      }
      notice(`${what} — retry ${attempt + 1}/${waitsS.length} in ${Math.round(delayMs / 1000)}s`);
      waited += delayMs;
      await wait(delayMs, init?.signal);
    }
  };
}
