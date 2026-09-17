// The one wrapper for every one-shot LLM call outside the agent loop — session
// titles, commit messages, and anything future that calls generateText directly.
// Automatically records every call's tokens — set once at boot with
// initHelperTokens, then every helperCall records without the caller knowing.
//
// The callers are fire-and-forget by nature: a failed recording must never fail
// the call itself. The wrapper catches and logs recording errors.
import { generateText } from 'ai';
import { languageModel, type ModelConfig } from '../core/llm/createAgent.js';
import { logger } from './log.js';
import type { HelperUsage, HelperKind } from './helperUsage.js';
import type { TokenUsage, TokenKind } from './tokenUsage.js';

const log = logger('helper-call');

export type { HelperKind };

// Module-level — set once at server boot. Every helperCall records automatically.
let _tokenUsage: TokenUsage | null = null;
export function initHelperTokens(tu: TokenUsage): void { _tokenUsage = tu; }

export interface HelperCallOpts {
  /** Where usage is recorded (legacy). */
  usage?: HelperUsage;
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
  // Automatic token recording — always fires when the module is initialized.
  if (_tokenUsage) {
    try {
      await _tokenUsage.record({
        sessionId: opts.sessionId, kind: opts.kind as TokenKind,
        provider: opts.config.provider, model: opts.config.model,
        input: u.input, output: u.output,
        cacheRead: u.cache_read, cacheWrite: u.cache_write,
      });
    } catch (e) {
      log.warn({ kind: opts.kind, session: opts.sessionId, err: (e as Error).message },
        'could not record token usage');
    }
  }
  // Legacy path — still runs alongside until helper_llm_usage is dropped.
  if (opts.usage) {
    try {
      await opts.usage.record({ kind: opts.kind, sessionId: opts.sessionId, provider: opts.config.provider,
        model: opts.config.model, systemPrompt: opts.system, userPrompt: opts.prompt, tokens: u });
    } catch (e) {
      log.warn({ kind: opts.kind, session: opts.sessionId, err: (e as Error).message },
        'could not record helper LLM usage');
    }
  }
  return { text, usage: u };
}
