// The log_tokens table's one owner. Every LLM call in the system lands here
// as one entry — core's languageModel() records each call it makes (see
// createAgent.ts) and this is the sink: the server hands it LogTokens.record
// directly; the CLI posts to /log-tokens, which calls the same method.
// Nothing else writes the table; readers join it freely.
import { gte, eq, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import type { Db } from './db/client.js';
import { logTokens } from './db/schema.js';
import { newId } from '../core/ids.js';
import type { TokenRecord } from '../core/llm/createAgent.js';

export type { TokenRecord };

/** A bigint SUM comes back from pg as text; mapWith(Number) makes it the
 *  number the type says it is (the same rule Sessions.list applies). */
const sum = (col: PgColumn) => sql<number>`coalesce(sum(${col}), 0)`.mapWith(Number);

export class LogTokens {
  constructor(private readonly db: Db) {}

  /** Record one LLM call. */
  async record(r: TokenRecord): Promise<void> {
    await this.db.insert(logTokens).values({
      id: newId(),
      sessionId: r.sessionId ?? null,
      kind: r.kind,
      provider: r.provider,
      model: r.model,
      responseId: r.responseId ?? null,
      tokensInput: r.input,
      tokensOutput: r.output,
      tokensCacheRead: r.cacheRead,
      tokensCacheWrite: r.cacheWrite,
    });
  }

  /** Lifetime totals for one session. */
  async sessionTotals(sessionId: string): Promise<{
    input: number; output: number; cacheRead: number; cacheWrite: number;
  }> {
    const [row] = await this.db
      .select({
        input: sum(logTokens.tokensInput),
        output: sum(logTokens.tokensOutput),
        cacheRead: sum(logTokens.tokensCacheRead),
        cacheWrite: sum(logTokens.tokensCacheWrite),
      })
      .from(logTokens)
      .where(eq(logTokens.sessionId, sessionId));
    return row ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }

  /** The /tokens report's rows: one per kind × provider × model, each
   *  carrying its sums for the three windows at once — `FILTER (WHERE …)`
   *  splits per window inside one scan bounded by the widest. Filters by
   *  created_at (when the call happened), not session activity. */
  async report(since: Windows<Date>): Promise<ReportRow[]> {
    const windowed = (col: PgColumn | null, from: Date) => sql<number>`coalesce(${
      col ? sql`sum(${col})` : sql`count(*)`
    } filter (where ${logTokens.createdAt} >= ${from}), 0)`.mapWith(Number);
    const window = (from: Date) => ({
      input: windowed(logTokens.tokensInput, from),
      output: windowed(logTokens.tokensOutput, from),
      cacheRead: windowed(logTokens.tokensCacheRead, from),
      calls: windowed(null, from),
    });
    const rows = await this.db
      .select({
        kind: logTokens.kind, provider: logTokens.provider, model: logTokens.model,
        today: window(since.today), week: window(since.week), month: window(since.month),
      })
      .from(logTokens)
      .where(gte(logTokens.createdAt, since.month))
      .groupBy(logTokens.kind, logTokens.provider, logTokens.model);
    return rows;
  }
}

/** The report's windows — today, and rolling 7 / 30 days. */
export interface Windows<T> { today: T; week: T; month: T }
/** One window's sums for one report row. */
export interface WindowTotals { input: number; output: number; cacheRead: number; calls: number }
export interface ReportRow extends Windows<WindowTotals> {
  kind: string; provider: string | null; model: string | null;
}
