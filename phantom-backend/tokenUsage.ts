// The ONE owner of token recording and querying for every LLM call in the
// system — agent steps (coding, supervisor, assistant) and helper calls
// (titles, commit messages, compaction, digests) alike. Every writer and
// reader goes through this class; nothing else touches the token_usage table.
import { gte, eq, sql } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { tokenUsage } from './db/schema.js';
import { newId } from '../core/ids.js';

/** The kinds that live in the table — agent turns and helper calls. */
export type TokenKind =
  | 'coding' | 'supervisor' | 'assistant'
  | 'title' | 'commit_message' | 'compaction' | 'session_digest';

export interface TokenRecord {
  sessionId?: string | null;
  kind: TokenKind;
  provider?: string | null;
  model?: string | null;
  responseId?: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export class TokenUsage {
  constructor(private readonly db: Db) {}

  /** Record one LLM call — one agent step or one helper call. */
  async record(r: TokenRecord): Promise<void> {
    await this.db.insert(tokenUsage).values({
      id: newId(),
      sessionId: r.sessionId ?? null,
      kind: r.kind,
      provider: r.provider ?? null,
      model: r.model ?? null,
      responseId: r.responseId ?? null,
      tokensInput: r.input,
      tokensOutput: r.output,
      tokensCacheRead: r.cacheRead,
      tokensCacheWrite: r.cacheWrite,
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
    return row ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }

  /** Token totals per provider/model since `since` — the /tokens report.
   *  Filters by created_at (when the call happened), not session activity. */
  async totalsByModel(since: Date): Promise<Array<{
    provider: string | null; model: string | null;
    input: number; output: number; cacheRead: number; cacheWrite: number;
  }>> {
    return this.db
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
  }

  /** Token totals per kind since `since` — helpers + agent types. */
  async totalsByKind(since: Date): Promise<Array<{
    kind: string; input: number; output: number;
    cacheRead: number; cacheWrite: number; calls: number;
  }>> {
    return this.db
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
  }
}
