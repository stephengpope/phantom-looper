// The one place a provider client is built. Every model handle comes from
// `billedModel()`: the provider switch, the Anthropic subscription-token
// disguise, the retry fetch, and the billing middleware that posts every
// call's usage to the backend. There is no way to call a model without
// going through this, so nothing is ever unbilled. The Agent uses it for
// its turns; an app uses it for a one-shot call (a title, a commit message).
import { wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware } from 'ai';
import type { LanguageModelV4Usage } from '@ai-sdk/provider';
import type { BackendClient } from '../backend.js';
import type { TokenUsage } from '../transcript.js';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createDeepSeek } from '@ai-sdk/deepseek';
import { createMoonshotAI } from '@ai-sdk/moonshotai';
import { createXai } from '@ai-sdk/xai';
import { createMistral } from '@ai-sdk/mistral';
import { createGroq } from '@ai-sdk/groq';
import { createOpenAIOAuthTransport, type OpenAIOAuthSession } from '@openai-oauth/core';
import { PhantomError, asPhantomError } from '../errors.js';
import { withRetry, type RetryPolicy } from './retry.js';
import type { ModelSpec, Reasoning } from './llmConfig.js';

export type { ModelSpec };

export interface ModelHooks {
  /** Where each failed attempt is reported as it happens (withRetry). */
  notice: (text: string) => void;
  /** The provider retry schedule. Absent = MODEL_RETRY. */
  retry?: RetryPolicy;
  /** A usage record that could not be posted. */
  onBillingError: (error: PhantomError) => void;
}

/** What a call is billed to: the type of work (an agent's type, or a
 *  helper's name — 'title', 'commit_message') and the session it serves. */
export interface Billing { type: string; sessionId: string | null }

// ── Anthropic subscription tokens ─────────────────────────────────────────

/** Claude subscription OAuth tokens (sk-ant-oat…, sk-ant-sid…) authenticate
 *  with `Authorization: Bearer`, NOT `x-api-key`, and only land in their normal
 *  rate-limit pool when the request looks like the Claude Code CLI. A Console
 *  API key is sk-ant-api… (x-api-key). */
function isAnthropicOAuth(key: string | null | undefined): key is string {
  return !!key && key.startsWith('sk-ant-') && !key.startsWith('sk-ant-api');
}

const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Splice the Claude Code identity in as the FIRST system block. Idempotent. */
function withClaudeCodeIdentity(cur: unknown): Array<{ type: 'text'; text: string }> {
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
function anthropicOAuthFetch(base: typeof fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete('x-api-key');
    let body = init?.body;
    if (typeof body === 'string') {
      try {
        const json = JSON.parse(body) as { system?: unknown };
        json.system = withClaudeCodeIdentity(json.system);
        body = JSON.stringify(json);
      } catch (error) {
        // A non-JSON body is passed through untouched; nothing to rewrite.
        void error;
      }
    }
    return base(input, { ...init, headers, body });
  };
}

function anthropicProvider(spec: ModelSpec, fetchWith: typeof fetch) {
  if (isAnthropicOAuth(spec.apiKey)) {
    return createAnthropic({
      apiKey: 'unused',
      headers: {
        authorization: `Bearer ${spec.apiKey}`,
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'user-agent': 'claude-cli/2.1.75',
        'x-app': 'cli',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      fetch: anthropicOAuthFetch(fetchWith),
    });
  }
  return createAnthropic({ apiKey: keyFor(spec), fetch: fetchWith });
}

// ── OpenAI Codex (ChatGPT subscription) ───────────────────────────────────
// The credential arrives like every other key, from the server: `apiKey`
// is the ChatGPT session as JSON — { accessToken, accountId, refreshToken?,
// idToken? } (what `codex login` writes). Nothing is read from disk here.

function codexSession(spec: ModelSpec): OpenAIOAuthSession {
  try {
    const j = JSON.parse(keyFor(spec)) as Partial<OpenAIOAuthSession>;
    if (typeof j.accessToken === 'string' && typeof j.accountId === 'string') return j as OpenAIOAuthSession;
  } catch (error) {
    void error; // not JSON: refused below with the same message
  }
  throw new PhantomError('no_api_key', 'openai-codex: the key must be the ChatGPT session as JSON ({ accessToken, accountId, ... })');
}

function openaiCodexModel(spec: ModelSpec, fetchWith: typeof fetch): Exclude<LanguageModel, string> {
  const session = codexSession(spec);
  const transport = createOpenAIOAuthTransport({ auth: session, fetch: fetchWith });
  return createOpenAI({ apiKey: 'openai-oauth', baseURL: transport.baseURL, fetch: transport.fetch }).responses(spec.model);
}

/** The provider said the conversation no longer fits its window. One
 *  classification for every provider's wording. */
export function isContextTooLong(message: string): boolean {
  return /prompt is too long|request too large|context[_ ]length[_ ]exceeded|maximum context length|too many tokens|input is too long/i.test(message);
}

// ── thinking ──────────────────────────────────────────────────────────────

/** Models on which thinking cannot be turned off (`thinking: disabled` is a 400). */
function thinkingAlwaysOn(model: string): boolean {
  return /claude-fable-5/.test(model.toLowerCase());
}

/** The reasoning level actually sent: 'none' on a model that cannot stop
 *  thinking becomes 'minimal'. */
export function effectiveReasoning(spec: Pick<ModelSpec, 'provider' | 'model' | 'reasoning'>): Reasoning | undefined {
  if (spec.reasoning === null) return undefined;
  if (spec.reasoning === 'none' && spec.provider === 'anthropic' && thinkingAlwaysOn(spec.model)) return 'minimal';
  return spec.reasoning;
}

// ── the handle ────────────────────────────────────────────────────────────

function keyFor(spec: ModelSpec): string {
  if (spec.apiKey) return spec.apiKey;
  throw new PhantomError('no_api_key', `no API key for provider ${spec.provider} — set its key on /keys`);
}

function providerModel(spec: ModelSpec, fetchWith: typeof fetch): Exclude<LanguageModel, string> {
  const endpoint = spec.baseUrl ?? undefined;
  switch (spec.provider) {
    case 'anthropic': return anthropicProvider(spec, fetchWith)(spec.model);
    case 'openai': return createOpenAI({ apiKey: keyFor(spec), baseURL: endpoint, fetch: fetchWith })(spec.model);
    case 'openai-codex': return openaiCodexModel(spec, fetchWith);
    case 'google': return createGoogleGenerativeAI({ apiKey: keyFor(spec), fetch: fetchWith })(spec.model);
    case 'deepseek': return createDeepSeek({ apiKey: keyFor(spec), baseURL: endpoint, fetch: fetchWith })(spec.model);
    case 'kimi': return createMoonshotAI({ apiKey: keyFor(spec), baseURL: endpoint, fetch: fetchWith })(spec.model);
    case 'xai': return createXai({ apiKey: keyFor(spec), baseURL: endpoint, fetch: fetchWith }).chat(spec.model);
    case 'mistral': return createMistral({ apiKey: keyFor(spec), baseURL: endpoint, fetch: fetchWith })(spec.model);
    case 'groq': return createGroq({ apiKey: keyFor(spec), baseURL: endpoint, fetch: fetchWith })(spec.model);
    case 'openai-compatible':
      if (!spec.baseUrl) throw new PhantomError('config_invalid', 'provider is openai-compatible but no endpoint is set');
      return createOpenAICompatible({ name: 'phantom', baseURL: spec.baseUrl, apiKey: spec.apiKey ?? 'none', fetch: fetchWith })(spec.model);
    default:
      throw new PhantomError('config_invalid', `provider "${String((spec as { provider: string }).provider)}" is not supported`);
  }
}

/** The middleware that bills: usage is read where the AI SDK reads it — the
 *  generate result, or the stream's `finish` part. */
function billingMiddleware(spec: ModelSpec, usage: (usage: TokenUsage) => void): LanguageModelMiddleware {
  const emit = (rawUsage: LanguageModelV4Usage, responseId?: string) => usage({
    provider: spec.provider, model: spec.model, responseId,
    input: rawUsage.inputTokens.total ?? 0, output: rawUsage.outputTokens.total ?? 0,
    cacheRead: rawUsage.inputTokens.cacheRead ?? 0, cacheWrite: rawUsage.inputTokens.cacheWrite ?? 0,
  });
  return {
    specificationVersion: 'v4',
    wrapGenerate: async ({ doGenerate }) => {
      const result = await doGenerate();
      emit(result.usage, result.response?.id);
      return result;
    },
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      let responseId: string | undefined;
      return { ...result, stream: result.stream.pipeThrough(new TransformStream({
        transform(part, controller) {
          if (part.type === 'response-metadata') responseId = part.id ?? responseId;
          else if (part.type === 'finish') emit(part.usage, responseId);
          controller.enqueue(part);
        },
      })) };
    },
  };
}

/** A provider model handle with retries, every call billed to `bill` on
 *  the backend (POST /log-tokens). The one way to get a model. */
export function billedModel(backend: BackendClient, spec: ModelSpec, bill: Billing, hooks: ModelHooks): LanguageModel {
  const model = providerModel(spec, withRetry(undefined, hooks.notice, 'model', hooks.retry));
  const post = (usage: TokenUsage) => backend.call('POST', '/log-tokens', { type: bill.type, sessionId: bill.sessionId, ...usage })
    .then(() => undefined, (error: unknown) => hooks.onBillingError(asPhantomError(error, 'internal', 'billing')));
  return wrapLanguageModel({ model, middleware: billingMiddleware(spec, (usage) => { void post(usage); }) });
}
