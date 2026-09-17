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

  /** Token totals per provider/model since `since` — the /tokens report.
   *  Filters by created_at (when the call happened), not session activity. */
  async totalsByModel(since: Date): Promise<Array<{
    provider: string | null; model: string | null;
    input: number; output: number; cacheRead: number; cacheWrite: number;
  }>> {
    const rows = await this.db
      .select({
        provider: logTokens.provider,
        model: logTokens.model,
        input: sum(logTokens.tokensInput),
        output: sum(logTokens.tokensOutput),
        cacheRead: sum(logTokens.tokensCacheRead),
        cacheWrite: sum(logTokens.tokensCacheWrite),
      })
      .from(logTokens)
      .where(gte(logTokens.createdAt, since))
      .groupBy(logTokens.provider, logTokens.model);
    return rows;
  }

  /** Token totals per kind since `since` — helpers + agent types. */
  async totalsByKind(since: Date): Promise<Array<{
    kind: string; input: number; output: number;
    cacheRead: number; cacheWrite: number; calls: number;
  }>> {
    const rows = await this.db
      .select({
        kind: logTokens.kind,
        input: sum(logTokens.tokensInput),
        output: sum(logTokens.tokensOutput),
        cacheRead: sum(logTokens.tokensCacheRead),
        cacheWrite: sum(logTokens.tokensCacheWrite),
        calls: sql<number>`count(*)`.mapWith(Number),
      })
      .from(logTokens)
      .where(gte(logTokens.createdAt, since))
      .groupBy(logTokens.kind);
    return rows;
  }
}
