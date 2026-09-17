// The one wrapper for every one-shot LLM call outside an agent loop — session
// titles, commit messages, digests, compaction summaries. It exists so the two
// rules every model call follows are written once: the model comes from
// `languageModel()` (which records the tokens — see createAgent.ts), and
// `maxRetries: 0` (the retry loop is ours, in the fetch, never the SDK's).
import { generateText } from 'ai';
import { languageModel, type ModelConfig, type TokenUsageContext } from './createAgent.js';

export interface HelperCallOpts {
  config: ModelConfig;
  /** What the call is billed to. */
  usage: TokenUsageContext;
  system?: string;
  prompt: string;
  /** Output token cap. Unset = the model decides. */
  maxTokens?: number;
}

export async function helperCall(opts: HelperCallOpts): Promise<{ text: string }> {
  const { text } = await generateText({
    model: languageModel({ ...opts.config, usage: opts.usage }),
    maxRetries: 0,
    ...(opts.system ? { system: opts.system } : {}),
    prompt: opts.prompt,
    ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
  });
  return { text };
}
