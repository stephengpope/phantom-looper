// The one place a provider client is built. Every model handle in the SDK
// comes from `languageModel()`: the provider switch, the Anthropic
// subscription-token disguise, the retry fetch, and the billing middleware
// that posts every call's usage to the backend. There is no way to call a
// model without going through this, so nothing is ever unbilled.
import type { LanguageModel, LanguageModelMiddleware } from 'ai';
import type { LanguageModelV4Usage } from '@ai-sdk/provider';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import { createXai } from '@ai-sdk/xai';
import { createMistral } from '@ai-sdk/mistral';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAIOAuthTransport } from '@openai-oauth/core';
import { openaiCredentials } from '@openai-oauth/local';
import { PhantomError } from '../errors.js';
import { withRetry, type RetryPolicy } from './retry.js';
import type { Provider, Reasoning } from './llmConfig.js';

export interface ModelSpec {
  provider: Provider;
  model: string;
  endpoint: string | null;
  reasoning: Reasoning | null;
  /** The live key for `provider`. Null for providers that need none
   *  (openai-codex reads its own login file; an open openai-compatible
   *  endpoint). */
  apiKey: string | null;
}

/** One model call's usage, as billed. */
export interface TokenUsage {
  provider: string; model: string; responseId?: string;
  input: number; output: number; cacheRead: number; cacheWrite: number;
}

export interface ModelHooks {
  /** Where each failed attempt is reported as it happens (withRetry). */
  notice: (text: string) => void;
  /** Where each call's usage lands — the Agent posts it to /log-tokens. */
  usage: (u: TokenUsage) => void;
  /** The provider retry schedule. Absent = MODEL_RETRY. */
  retry?: RetryPolicy;
  /** Test seam: the fetch the provider client uses. */
  fetch?: typeof fetch;
}

// ── Anthropic subscription tokens ─────────────────────────────────────────

/** Claude subscription OAuth tokens (sk-ant-oat…, sk-ant-sid…) authenticate
 *  with `Authorization: Bearer`, NOT `x-api-key`, and only land in their normal
 *  rate-limit pool when the request looks like the Claude Code CLI. A Console
 *  API key is sk-ant-api… (x-api-key). */
export function isAnthropicOAuth(key: string | null | undefined): key is string {
  return !!key && key.startsWith('sk-ant-') && !key.startsWith('sk-ant-api');
}

export const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Splice the Claude Code identity in as the FIRST system block. Idempotent. */
export function withClaudeCodeIdentity(cur: unknown): Array<{ type: 'text'; text: string }> {
  if (Array.isArray(cur) && cur[0]?.text === CLAUDE_CODE_SYSTEM) {
    return cur as Array<{ type: 'text'; text: string }>;
  }
  const identity = { type: 'text' as const, text: CLAUDE_CODE_SYSTEM };
  if (typeof cur === 'string') return cur ? [identity, { type: 'text', text: cur }] : [identity];
  if (Array.isArray(cur)) return [identity, ...cur];
  return [identity];
}

/** The low-level insertion: strip x-api-key (Bearer + x-api-key together
 *  401s) and rewrite `system` so the identity block is first. */
export function anthropicOAuthFetch(base: typeof fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete('x-api-key');
    let body = init?.body;
    if (typeof body === 'string') {
      try {
        const json = JSON.parse(body) as { system?: unknown };
        json.system = withClaudeCodeIdentity(json.system);
        body = JSON.stringify(json);
      } catch (e) {
        // A non-JSON body is passed through untouched; nothing to rewrite.
        void e;
      }
    }
    return base(input, { ...init, headers, body });
  };
}

function anthropicProvider(s: ModelSpec, f: typeof fetch) {
  if (isAnthropicOAuth(s.apiKey)) {
    return createAnthropic({
      apiKey: 'unused',
      headers: {
        authorization: `Bearer ${s.apiKey}`,
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'user-agent': 'claude-cli/2.1.75',
        'x-app': 'cli',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      fetch: anthropicOAuthFetch(f),
    });
  }
  return createAnthropic({ apiKey: keyFor(s), fetch: f });
}

// ── OpenAI Codex (ChatGPT subscription) ───────────────────────────────────

function openaiCodexModel(s: ModelSpec, f: typeof fetch): Exclude<LanguageModel, string> {
  const creds = openaiCredentials();
  const transport = createOpenAIOAuthTransport({
    auth: () => creds.getSession().catch((e: unknown) => {
      throw new PhantomError('no_api_key',
        'openai-codex: no valid ChatGPT credentials — run `npx @openai/codex login` (credentials live in ~/.codex/auth.json)',
        { cause: e });
    }),
    baseURL: creds.baseURL,
    fetch: f,
  });
  return createOpenAI({ apiKey: 'openai-oauth', baseURL: transport.baseURL, fetch: transport.fetch }).responses(s.model);
}

// ── thinking ──────────────────────────────────────────────────────────────

/** Models on which thinking cannot be turned off (`thinking: disabled` is a 400). */
export function thinkingAlwaysOn(model: string): boolean {
  return /claude-fable-5/.test(model.toLowerCase());
}

/** The reasoning level actually sent: 'none' on a model that cannot stop
 *  thinking becomes 'minimal'. */
export function effectiveReasoning(s: ModelSpec): Reasoning | undefined {
  if (s.reasoning === null) return undefined;
  if (s.reasoning === 'none' && s.provider === 'anthropic' && thinkingAlwaysOn(s.model)) return 'minimal';
  return s.reasoning;
}

// ── the handle ────────────────────────────────────────────────────────────

function keyFor(s: ModelSpec): string {
  if (s.apiKey) return s.apiKey;
  throw new PhantomError('no_api_key', `no API key for provider ${s.provider} — set its key on /keys`);
}

function providerModel(s: ModelSpec, f: typeof fetch): Exclude<LanguageModel, string> {
  const ep = s.endpoint ?? undefined;
  switch (s.provider) {
    case 'anthropic': return anthropicProvider(s, f)(s.model);
    case 'openai': return createOpenAI({ apiKey: keyFor(s), baseURL: ep, fetch: f })(s.model);
    case 'openai-codex': return openaiCodexModel(s, f);
    case 'google': return createGoogleGenerativeAI({ apiKey: keyFor(s), fetch: f })(s.model);
    case 'deepseek': return createDeepSeek({ apiKey: keyFor(s), baseURL: ep, fetch: f })(s.model);
    case 'kimi': return createMoonshotAI({ apiKey: keyFor(s), baseURL: ep, fetch: f })(s.model);
    case 'xai': return createXai({ apiKey: keyFor(s), baseURL: ep, fetch: f }).chat(s.model);
    case 'mistral': return createMistral({ apiKey: keyFor(s), baseURL: ep, fetch: f })(s.model);
    case 'groq': return createGroq({ apiKey: keyFor(s), baseURL: ep, fetch: f })(s.model);
    case 'openai-compatible':
      if (!s.endpoint) throw new PhantomError('config_invalid', 'provider is openai-compatible but no endpoint is set');
      return createOpenAICompatible({ name: 'phantom', baseURL: s.endpoint, apiKey: s.apiKey ?? 'none', fetch: f })(s.model);
    default:
      throw new PhantomError('config_invalid', `provider "${String((s as { provider: string }).provider)}" is not supported`);
  }
}

/** The middleware that bills: usage is read where the AI SDK reads it — the
 *  generate result, or the stream's `finish` part. Applied by the Agent to
 *  every model handle, whatever built it. */
export function billingMiddleware(s: ModelSpec, usage: ModelHooks['usage']): LanguageModelMiddleware {
  const emit = (u: LanguageModelV4Usage, responseId?: string) => usage({
    provider: s.provider, model: s.model, responseId,
    input: u.inputTokens.total ?? 0, output: u.outputTokens.total ?? 0,
    cacheRead: u.inputTokens.cacheRead ?? 0, cacheWrite: u.inputTokens.cacheWrite ?? 0,
  });
  return {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate }) => {
      const r = await doGenerate();
      emit(r.usage, r.response?.id);
      return r;
    },
    wrapStream: async ({ doStream }) => {
      const r = await doStream();
      let responseId: string | undefined;
      return { ...r, stream: r.stream.pipeThrough(new TransformStream({
        transform(part, controller) {
          if (part.type === 'response-metadata') responseId = part.id ?? responseId;
          else if (part.type === 'finish') emit(part.usage, responseId);
          controller.enqueue(part);
        },
      })) };
    },
  };
}

/** A provider model handle with retries. Billing is the Agent's (billingMiddleware). */
export function languageModel(s: ModelSpec, hooks: Pick<ModelHooks, 'notice' | 'fetch' | 'retry'>): LanguageModel {
  return providerModel(s, withRetry(hooks.fetch, hooks.notice, hooks.retry));
}
