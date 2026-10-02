// TokenLog — every model call in the system, one row: who (kind, session),
// what (provider, model), and the tokens (input, output, cache read/write).
// The cli's calls post here too. Stub.
export interface TokenRecord {
  sessionId: string | null; kind: string; provider: string; model: string; responseId?: string;
  input: number; output: number; cacheRead: number; cacheWrite: number;
}
export interface TokenTotals { input: number; output: number; cacheRead: number; cacheWrite: number; calls: number }

export class TokenLog {
  async record(record: TokenRecord): Promise<void> { throw stub(); }
  async sessionTotals(sessionId: string): Promise<TokenTotals> { throw stub(); }
  /** Totals per kind/provider/model over each window (today, 7d, 30d). */
  async report(windows: { today: Date; week: Date; month: Date }): Promise<Array<{ kind: string; provider: string; model: string | null; today: TokenTotals; week: TokenTotals; month: TokenTotals }>> { throw stub(); }
}
const stub = () => new Error('stub');
