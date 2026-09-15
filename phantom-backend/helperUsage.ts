// The helper LLM usage row's one owner: every one-shot generateText call that
// is not part of an agent turn — session titles, commit messages, digests,
// compaction — with its tokens, so coding + assistant sessions + these =
// 100% of spend (migration 020).
import { gte, sql } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { helperLlmUsage } from './db/schema.js';
import { newId } from '../core/ids.js';

export type HelperKind = 'title' | 'commit_message' | 'session_digest' | 'compaction';

export class HelperUsage {
  constructor(private readonly db: Db) {}

  /** One call landed. */
  async record(call: {
    kind: HelperKind; sessionId?: string | null; provider: string; model: string;
    systemPrompt?: string | null; userPrompt: string;
    tokens: { input: number; output: number; cache_read: number; cache_write: number };
  }): Promise<void> {
    await this.db.insert(helperLlmUsage).values({
      id: newId(), kind: call.kind, sessionId: call.sessionId ?? null,
      provider: call.provider, model: call.model,
      systemPrompt: call.systemPrompt ?? null, userPrompt: call.userPrompt,
      tokensInput: call.tokens.input, tokensOutput: call.tokens.output,
      tokensCacheRead: call.tokens.cache_read, tokensCacheWrite: call.tokens.cache_write,
    });
  }

  /** Token totals per helper kind since `since` — /system/token-usage. */
  async totalsByKind(since: Date): Promise<Array<{ kind: string; input: number; output: number;
    cacheRead: number; cacheWrite: number; calls: number }>> {
    const rows = await this.db
      .select({
        kind: helperLlmUsage.kind,
        input: sql<number>`coalesce(sum(${helperLlmUsage.tokensInput}), 0)`.as('h_input'),
        output: sql<number>`coalesce(sum(${helperLlmUsage.tokensOutput}), 0)`.as('h_output'),
        cacheRead: sql<number>`coalesce(sum(${helperLlmUsage.tokensCacheRead}), 0)`.as('h_cache_read'),
        cacheWrite: sql<number>`coalesce(sum(${helperLlmUsage.tokensCacheWrite}), 0)`.as('h_cache_write'),
        calls: sql<number>`count(*)::int`.as('h_calls'),
      })
      .from(helperLlmUsage)
      .where(gte(helperLlmUsage.createdAt, since))
      .groupBy(helperLlmUsage.kind);
    return rows.map((r) => ({ ...r, input: Number(r.input), output: Number(r.output),
      cacheRead: Number(r.cacheRead), cacheWrite: Number(r.cacheWrite), calls: Number(r.calls) }));
  }
}
