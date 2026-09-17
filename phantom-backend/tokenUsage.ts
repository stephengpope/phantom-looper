// The token_usage table's one owner. Every LLM call in the system lands here
// as one row — core's languageModel() records each call it makes (see
// createAgent.ts) and this is the sink: the server hands it TokenUsage.record
// directly; the CLI posts to /token-usage, which calls the same method.
// Nothing else writes the table; readers join it freely.
import { gte, eq, sql } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { tokenUsage } from './db/schema.js';
import { newId } from '../core/ids.js';
import type { TokenRecord } from '../core/llm/createAgent.js';

export type { TokenRecord };

export class TokenUsage {
  constructor(private readonly db: Db) {}

  /** Record one LLM call. */
  async record(r: TokenRecord): Promise<void> {
    await this.db.insert(tokenUsage).values({
      id: newId(),
      sessionId: r.sessionId ?? null,
      kind: r.kind,
      provider: r.provider,
      model: r.model,
      responseId: r.responseId ?? null,
      tokensInput: r.input,
      tokensOutput: r.output,
      tokensCacheRead: r.cache_read,
      tokensCacheWrite: r.cache_write,
    });
  }

  /** Lifetime totals for one session — replaces the old row cache. */
  async sessionTotals(sessionId: string): Promise<{
    input: number; output: number; cacheRead: number; cacheWrite: number;
  }> {
    const [row] = await this.db
      .select({
        input: sql<number>`coalesce(sum(${tokenUsage.tokensInput}), 0)`.as('input'),
        output: sql<number>`coalesce(sum(${tokenUsage.tokensOutput}), 0)`.as('output'),
        cacheRead: sql<number>`coalesce(sum(${tokenUsage.tokensCacheRead}), 0)`.as('cache_read'),
        cacheWrite: sql<number>`coalesce(sum(${tokenUsage.tokensCacheWrite}), 0)`.as('cache_write'),
      })
      .from(tokenUsage)
      .where(eq(tokenUsage.sessionId, sessionId));
    if (!row) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    // PostgreSQL sum() on bigint returns numeric, which pg sends as a string.
    // Drizzle's sql<number> is a TS-only assertion — coerce at the boundary.
    return { input: Number(row.input), output: Number(row.output),
      cacheRead: Number(row.cacheRead), cacheWrite: Number(row.cacheWrite) };
  }

  /** Token totals per provider/model since `since` — the /tokens report.
   *  Filters by created_at (when the call happened), not session activity. */
  async totalsByModel(since: Date): Promise<Array<{
    provider: string | null; model: string | null;
    input: number; output: number; cacheRead: number; cacheWrite: number;
  }>> {
    const rows = await this.db
      .select({
        provider: tokenUsage.provider,
        model: tokenUsage.model,
        input: sql<number>`coalesce(sum(${tokenUsage.tokensInput}), 0)`.as('input'),
        output: sql<number>`coalesce(sum(${tokenUsage.tokensOutput}), 0)`.as('output'),
        cacheRead: sql<number>`coalesce(sum(${tokenUsage.tokensCacheRead}), 0)`.as('cache_read'),
        cacheWrite: sql<number>`coalesce(sum(${tokenUsage.tokensCacheWrite}), 0)`.as('cache_write'),
      })
      .from(tokenUsage)
      .where(gte(tokenUsage.createdAt, since))
      .groupBy(tokenUsage.provider, tokenUsage.model);
    return rows.map((r) => ({ ...r, input: Number(r.input), output: Number(r.output),
      cacheRead: Number(r.cacheRead), cacheWrite: Number(r.cacheWrite) }));
  }

  /** Token totals per kind since `since` — helpers + agent types. */
  async totalsByKind(since: Date): Promise<Array<{
    kind: string; input: number; output: number;
    cacheRead: number; cacheWrite: number; calls: number;
  }>> {
    const rows = await this.db
      .select({
        kind: tokenUsage.kind,
        input: sql<number>`coalesce(sum(${tokenUsage.tokensInput}), 0)`.as('input'),
        output: sql<number>`coalesce(sum(${tokenUsage.tokensOutput}), 0)`.as('output'),
        cacheRead: sql<number>`coalesce(sum(${tokenUsage.tokensCacheRead}), 0)`.as('cache_read'),
        cacheWrite: sql<number>`coalesce(sum(${tokenUsage.tokensCacheWrite}), 0)`.as('cache_write'),
        calls: sql<number>`count(*)::int`.as('calls'),
      })
      .from(tokenUsage)
      .where(gte(tokenUsage.createdAt, since))
      .groupBy(tokenUsage.kind);
    return rows.map((r) => ({ ...r, input: Number(r.input), output: Number(r.output),
      cacheRead: Number(r.cacheRead), cacheWrite: Number(r.cacheWrite), calls: Number(r.calls) }));
  }
}
