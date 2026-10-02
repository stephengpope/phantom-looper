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
  onBillingError: (e: PhantomError) => void;
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
// The credential arrives like every other key, from the server: `apiKey`
// is the ChatGPT session as JSON — { accessToken, accountId, refreshToken?,
// idToken? } (what `codex login` writes). Nothing is read from disk here.

function codexSession(s: ModelSpec): OpenAIOAuthSession {
  try {
    const j = JSON.parse(keyFor(s)) as Partial<OpenAIOAuthSession>;
    if (typeof j.accessToken === 'string' && typeof j.accountId === 'string') return j as OpenAIOAuthSession;
  } catch (e) {
    void e; // not JSON: refused below with the same message
  }
  throw new PhantomError('no_api_key', 'openai-codex: the key must be the ChatGPT session as JSON ({ accessToken, accountId, ... })');
}

function openaiCodexModel(s: ModelSpec, f: typeof fetch): Exclude<LanguageModel, string> {
  const session = codexSession(s);
  const transport = createOpenAIOAuthTransport({ auth: session, fetch: f });
  return createOpenAI({ apiKey: 'openai-oauth', baseURL: transport.baseURL, fetch: transport.fetch }).responses(s.model);
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
export function effectiveReasoning(s: Pick<ModelSpec, 'provider' | 'model' | 'reasoning'>): Reasoning | undefined {
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
  const ep = s.baseUrl ?? undefined;
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
      if (!s.baseUrl) throw new PhantomError('config_invalid', 'provider is openai-compatible but no endpoint is set');
      return createOpenAICompatible({ name: 'phantom', baseURL: s.baseUrl, apiKey: s.apiKey ?? 'none', fetch: f })(s.model);
    default:
      throw new PhantomError('config_invalid', `provider "${String((s as { provider: string }).provider)}" is not supported`);
  }
}

/** The middleware that bills: usage is read where the AI SDK reads it — the
 *  generate result, or the stream's `finish` part. */
function billingMiddleware(s: ModelSpec, usage: (u: TokenUsage) => void): LanguageModelMiddleware {
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

/** A provider model handle with retries, every call billed to `bill` on
 *  the backend (POST /log-tokens). The one way to get a model. */
export function billedModel(backend: BackendClient, s: ModelSpec, bill: Billing, hooks: ModelHooks): LanguageModel {
  const model = providerModel(s, withRetry(undefined, hooks.notice, 'model', hooks.retry));
  const post = (u: TokenUsage) => backend.call('POST', '/log-tokens', { kind: bill.type, sessionId: bill.sessionId, ...u })
    .then(() => undefined, (e: unknown) => hooks.onBillingError(asPhantomError(e, 'internal', 'billing')));
  return wrapLanguageModel({ model, middleware: billingMiddleware(s, (u) => { void post(u); }) });
}
