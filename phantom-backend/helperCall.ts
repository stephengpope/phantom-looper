// The one wrapper for every one-shot LLM call outside the agent loop — session
// titles, commit messages, and anything future that calls generateText directly.
// Records the call's full context and usage to helper_llm_usage, so /status
// accounts for 100% of LLM spend.
//
// The callers are fire-and-forget by nature: a failed recording must never fail
// the call itself. The wrapper catches and logs recording errors.
import { generateText } from 'ai';
import { languageModel, type ModelConfig } from '../core/llm/createAgent.js';
import { helperLlmUsage } from './db/schema.js';
import { newId } from '../core/ids.js';
import { logger } from './log.js';
import type { Db } from './db/client.js';

const log = logger('helper-call');

export type HelperKind = 'title' | 'commit_message' | 'session_digest' | 'compaction';

export interface HelperCallOpts {
  /** The database to record usage in. When absent, the call runs normally but
   *  usage is not recorded — for callers outside the server process. */
  db?: Db;
  config: ModelConfig;
  kind: HelperKind;
  /** The session this call serves — null when not tied to one. */
  sessionId?: string | null;
  system?: string;
  prompt: string;
  maxRetries?: number;
  /** Output token cap. Unset = the model decides. */
  maxTokens?: number;
}

export interface HelperCallResult {
  text: string;
  usage: {
    input: number;
    output: number;
    cache_read: number;
    cache_write: number;
  };
}

/** Call generateText and record the usage. Returns the text and the normalized
 *  usage. The recording is best-effort — a failed insert logs and moves on. */
export async function helperCall(opts: HelperCallOpts): Promise<HelperCallResult> {
  const { text, usage } = await generateText({
    model: languageModel(opts.config),
    maxRetries: opts.maxRetries ?? 0,
    ...(opts.system ? { system: opts.system } : {}),
    prompt: opts.prompt,
    ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
  });
  const u = {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
    cache_read: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    cache_write: usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
  // Best-effort: a failed insert must never break the caller.
  if (!opts.db) return { text, usage: u };
  try {
    await opts.db.insert(helperLlmUsage).values({
      id: newId(),
      kind: opts.kind,
      sessionId: opts.sessionId ?? null,
      provider: opts.config.provider,
      model: opts.config.model,
      systemPrompt: opts.system ?? null,
      userPrompt: opts.prompt,
      tokensInput: u.input,
      tokensOutput: u.output,
      tokensCacheRead: u.cache_read,
      tokensCacheWrite: u.cache_write,
    });
  } catch (e) {
    log.warn({ kind: opts.kind, session: opts.sessionId, err: (e as Error).message },
      'could not record helper LLM usage');
  }
  return { text, usage: u };
}
