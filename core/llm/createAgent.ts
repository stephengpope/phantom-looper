// The one place an LLM agent is assembled. Every caller — the server's Git
// Fixer, the TUI's coding agent, the TUI's Assistant, the example agent —
// builds its agent here and then talks to it with the AI SDK's own
// methods (`agent.stream()`, `agent.generate()`). Nothing else in the tree
// constructs a provider client.
//
// What lives here, so it is fixed once:
// - the provider switch (anthropic | openai | google | openai-compatible) —
//   provider packages only, no gateway;
// - the Anthropic subscription-token disguise (OAuth tokens authenticate with
//   Bearer, carry the Claude Code CLI headers, and need the Claude Code
//   identity as the first system block) — see `anthropicProvider`;
// - the thinking rule: the AI SDK maps `reasoning: 'none'` to
//   `thinking: disabled`, which Claude Fable rejects with a 400 (thinking
//   cannot be turned off on that model; verified live 2026-08-23). Here
//   'none' becomes 'minimal' (adaptive thinking at effort "low") for that
//   family and stays 'none' (no thinking at all) for every other model —
//   on haiku-4-5, 'minimal' would switch thinking ON.
import { ToolLoopAgent, isStepCount, type LanguageModel, type ModelMessage, type Tool } from 'ai';
import type { StepRecord } from './transcript.js';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

export const PROVIDERS = ['anthropic', 'openai', 'google', 'openai-compatible'] as const;
export type Provider = typeof PROVIDERS[number];
export type Reasoning = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ModelConfig {
  provider: Provider;
  model: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  /** The portable AI SDK knob; each provider maps it to its own setting. Omit
   *  to leave the provider's default. */
  reasoning?: Reasoning;
  /** Test seam: the fetch the provider client uses. Production never sets it. */
  fetch?: typeof fetch;
  /** Where each failed model attempt is reported as it happens ("model
   *  answered 429 (rate limited) — retry 2/7 in 4s"). The cli notes it into
   *  the session's conversation, the looper logs it. Absent = silent retries. */
  onRetry?: (note: string) => void;
}

export function isProvider(s: string): s is Provider {
  return (PROVIDERS as readonly string[]).includes(s);
}

// --- Anthropic subscription tokens ------------------------------------------------

/** Claude subscription OAuth tokens (sk-ant-oat…, sk-ant-sid…) authenticate
 *  with `Authorization: Bearer`, NOT `x-api-key`, and only land in their normal
 *  rate-limit pool when the request looks like the Claude Code CLI. A Console
 *  API key is sk-ant-api… (x-api-key). */
export function isAnthropicOAuth(key: string | null | undefined): key is string {
  return !!key && key.startsWith('sk-ant-') && !key.startsWith('sk-ant-api');
}

export const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Splice the Claude Code identity in as the FIRST system block, ahead of `cur`
 *  (a Messages-API `system` field: a string, a block array, or absent).
 *  Idempotent — if the identity is already first, `cur` comes back untouched. */
export function withClaudeCodeIdentity(cur: unknown): Array<{ type: 'text'; text: string }> {
  if (Array.isArray(cur) && cur[0]?.text === CLAUDE_CODE_SYSTEM) {
    return cur as Array<{ type: 'text'; text: string }>;
  }
  const identity = { type: 'text' as const, text: CLAUDE_CODE_SYSTEM };
  if (typeof cur === 'string') return cur ? [identity, { type: 'text', text: cur }] : [identity];
  if (Array.isArray(cur)) return [identity, ...cur];
  return [identity];
}

/** The low-level insertion. @ai-sdk/anthropic hands every request through this
 *  fetch with the fully-serialized JSON body, so we (1) strip x-api-key (the
 *  typed headers option can't send an `undefined` to remove it, and Bearer +
 *  x-api-key together 401s) and (2) rewrite `system` via withClaudeCodeIdentity
 *  — the subscription gate requires that block verbatim and first. The caller's
 *  real instructions ride right behind it. Non-JSON bodies pass through. */
export function anthropicOAuthFetch(base: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.delete('x-api-key');
    let body = init?.body;
    if (typeof body === 'string') {
      try {
        const json = JSON.parse(body);
        json.system = withClaudeCodeIdentity(json.system);
        body = JSON.stringify(json);
      } catch {
        // non-JSON body — leave it untouched
      }
    }
    return base(input, { ...init, headers, body });
  };
}

function anthropicProvider(c: ModelConfig) {
  if (isAnthropicOAuth(c.apiKey)) {
    return createAnthropic({
      apiKey: 'unused', // never sent — x-api-key is stripped, Bearer set below
      headers: {
        authorization: `Bearer ${c.apiKey}`,
        'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20',
        'user-agent': 'claude-cli/2.1.75',
        'x-app': 'cli',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      fetch: anthropicOAuthFetch(c.fetch),
    });
  }
  return createAnthropic({ apiKey: c.apiKey ?? undefined, fetch: c.fetch });
}

// --- thinking ---------------------------------------------------------------------

/** Models on which thinking cannot be turned off (`thinking: disabled` is a 400). */
export function thinkingAlwaysOn(model: string): boolean {
  return /claude-fable-5/.test(model.toLowerCase());
}

/** The reasoning level actually sent: 'none' on a model that cannot stop
 *  thinking becomes 'minimal' (its lowest effort); everything else is passed
 *  through. Only Anthropic models are special-cased. */
export function effectiveReasoning(provider: Provider, model: string, want: Reasoning | undefined): Reasoning | undefined {
  if (want === 'none' && provider === 'anthropic' && thinkingAlwaysOn(model)) return 'minimal';
  return want;
}

// --- the model and the agent -------------------------------------------------------

/** A provider-specific model handle. `createAgent` is the normal entry; this is
 *  for a one-shot call with no tools (`generateText({ model, ... })`). The
 *  retry loop rides in HERE — `withRetry` wraps the fetch for every provider,
 *  so any model call built anywhere in the tree retries on our schedule;
 *  every SDK call sets maxRetries: 0 so nothing stacks a second loop on top. */
export function languageModel(cfg: ModelConfig): LanguageModel {
  const c: ModelConfig = { ...cfg, fetch: withRetry(cfg.fetch, cfg.onRetry) };
  switch (c.provider) {
    case 'anthropic': return anthropicProvider(c)(c.model);
    case 'openai': return createOpenAI({ apiKey: c.apiKey ?? undefined, baseURL: c.baseUrl ?? undefined, fetch: c.fetch })(c.model);
    case 'google': return createGoogleGenerativeAI({ apiKey: c.apiKey ?? undefined, fetch: c.fetch })(c.model);
    case 'openai-compatible':
      if (!c.baseUrl) throw new Error('openai-compatible needs a base url');
      return createOpenAICompatible({ name: 'phantom-looper', baseURL: c.baseUrl, apiKey: c.apiKey ?? 'none', fetch: c.fetch })(c.model);
    default: throw new Error(`unknown provider "${String((c as { provider: string }).provider)}"`);
  }
}

// --- retries ----------------------------------------------------------------------
// WE own the retry schedule, not the SDK. The AI SDK's retry loop hardcodes
// 2s-doubling with no way to shape it, so retries live in the fetch wrapper
// below (`withRetry`, applied inside `languageModel` for every provider) and
// every SDK call sets `maxRetries: 0` — one retry loop, ours, never stacked.

/** The waits between attempts, in seconds. Grows per fail, totals 164s. */
export const RETRY_WAITS_S = [2, 4, 8, 15, 30, 45, 60] as const;
/** Hard ceiling on TOTAL time spent waiting — a call can never retry past
 *  this, whatever retry-after asks for. Well inside session_lock_ttl_ms
 *  (10 min), so a retrying looper round cannot outlive its session lock. */
export const RETRY_BUDGET_MS = 180_000;

const RETRYABLE_STATUS = (s: number) => s === 408 || s === 409 || s === 429 || s >= 500;

/** retry-after, when the server sent one: used if it asks for MORE than our
 *  scheduled wait (retrying sooner than the server said is a wasted call),
 *  capped at 60s — the budget check above still has the last word. */
function serverDelayMs(r: Response, scheduledMs: number): number {
  const h = r.headers.get('retry-after-ms') ?? r.headers.get('retry-after');
  if (!h) return scheduledMs;
  const n = parseFloat(h);
  const ms = r.headers.get('retry-after-ms') ? n
    : Number.isNaN(n) ? Date.parse(h) - Date.now() : n * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return scheduledMs;
  return Math.min(60_000, Math.max(scheduledMs, ms));
}

const wait = (ms: number, signal?: AbortSignal | null) => new Promise<void>((res, rej) => {
  const onAbort = () => { clearTimeout(t); rej(signal?.reason ?? new DOMException('aborted', 'AbortError')); };
  const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); res(); }, ms);
  if (signal?.aborted) return onAbort();
  signal?.addEventListener('abort', onAbort, { once: true });
});

/** THE retry loop — a fetch wrapper, so it works identically for every
 *  provider and every kind of call. Retryable failures (429/408/409/5xx and
 *  network errors) wait out RETRY_WAITS_S and try again, reporting each
 *  attempt as it happens (`report` — the cli notes it into the conversation,
 *  the looper logs it; silence was the old bug). Fatal statuses (400/401/
 *  403/404) return at once for the SDK to throw. Aborting cancels a wait
 *  immediately. A non-replayable body (streaming upload) is never retried. */
export function withRetry(
  inner?: typeof fetch, report?: (note: string) => void,
): typeof fetch {
  const f = inner ?? fetch;
  return async (input, init) => {
    const replayable = init?.body == null || typeof init.body === 'string';
    let waited = 0;
    for (let attempt = 0; ; attempt++) {
      let r: Response | undefined;
      let netErr: unknown;
      try {
        r = await f(input, init);
      } catch (e) {
        // Only a genuine network failure retries — fetch rejects those as
        // TypeError ('fetch failed'). Aborts and everything else (a bug, a
        // test seam) are not transient and rethrow untouched.
        if (!(e instanceof TypeError)) throw e;
        netErr = e;
      }
      if (r && !RETRYABLE_STATUS(r.status)) return r;

      const what = netErr ? `model unreachable (${(netErr as Error)?.message ?? String(netErr)})`
        : r!.status === 429 ? 'model answered 429 (rate limited)'
        : r!.status === 529 ? 'model answered 529 (overloaded)'
        : `model answered ${r!.status}`;
      const scheduled = RETRY_WAITS_S[attempt];
      const delayMs = scheduled === undefined ? undefined
        : r ? serverDelayMs(r, scheduled * 1000) : scheduled * 1000;
      if (!replayable || delayMs === undefined || waited + delayMs > RETRY_BUDGET_MS) {
        report?.(`${what} — giving up after ${attempt} ${attempt === 1 ? 'retry' : 'retries'}`);
        if (netErr) throw netErr;
        return r!;
      }
      report?.(`${what} — retry ${attempt + 1}/${RETRY_WAITS_S.length} in ${Math.round(delayMs / 1000)}s`);
      waited += delayMs;
      await wait(delayMs, init?.signal);
    }
  };
}

/**
 * Prompt caching. Anthropic caches everything *before* a breakpoint, so two
 * marks cover a growing conversation: one on the first message (tools + system
 * + that message — the prefix that never changes) and a rolling one on the
 * last, which the next call reads back as its cached prefix. Without them
 * every call re-bills the whole history — and the cache lives at Anthropic,
 * keyed on the byte-identical prefix, so a session resumed on another machine
 * (or a looper round after a cli turn) still hits it within the TTL. Other
 * providers cache automatically and ignore the anthropic options block. The
 * marks go on copies: history is what we persist and replay, and it stays
 * clean.
 */
export function withCacheBreakpoints(messages: ModelMessage[]): ModelMessage[] {
  const mark = (m: ModelMessage): ModelMessage => ({
    ...m,
    providerOptions: { ...m.providerOptions, anthropic: { cacheControl: { type: 'ephemeral' } } },
  });
  if (messages.length === 0) return messages;
  const out = [...messages];
  out[0] = mark(out[0]);
  out[out.length - 1] = mark(out[out.length - 1]);
  return out;
}

export interface AgentSpec {
  /** The system prompt. */
  instructions: string;
  tools: Record<string, Tool>;
  /** Tool-call rounds per turn. `null`/undefined = unlimited: the turn ends
   *  only when the model stops calling tools (an abort signal still ends it).
   *  The SDK's own default when stopWhen is omitted is 20, NOT unlimited, so
   *  "unlimited" is spelled out rather than left to the default. */
  maxSteps?: number | null;
}

/** The one usage-recording seam, inherited by EVERY agent built here: pass
 *  `record` (a Transcript, or memoryRecorder's sink) to `stream`/`generate`
 *  and each step's messages + usage line land through it — no agent
 *  re-implements the bookkeeping. */
function spliceRecord<T extends { onStepEnd?: (step: never) => unknown }>(
  o: T & { record?: StepRecord },
): T {
  const { record, ...rest } = o;
  if (!record) return rest as T;
  const prior = rest.onStepEnd as ((step: unknown) => unknown) | undefined;
  return {
    ...rest,
    onStepEnd: (step: { response: { messages: unknown[] }; usage?: unknown }) => {
      record.appendStep(step.response.messages as ModelMessage[],
        step.usage as Parameters<StepRecord['appendStep']>[1]);
      return prior?.(step);
    },
  } as unknown as T;
}

class RecordingAgent<TOOLS extends Record<string, Tool>> extends ToolLoopAgent<never, TOOLS> {
  override stream(o: Parameters<ToolLoopAgent<never, TOOLS>['stream']>[0] & { record?: StepRecord }) {
    return super.stream(spliceRecord(o));
  }
  override generate(o: Parameters<ToolLoopAgent<never, TOOLS>['generate']>[0] & { record?: StepRecord }) {
    return super.generate(spliceRecord(o));
  }
}

/** Build the agent. Talk to it with the AI SDK's own `agent.stream({messages,
 *  abortSignal, onStepEnd})` / `agent.generate({prompt, abortSignal})` — plus
 *  the `record` option (above) on either. */
export function createAgent(c: ModelConfig, spec: AgentSpec) {
  const reasoning = effectiveReasoning(c.provider, c.model, c.reasoning);
  return new RecordingAgent({
    model: languageModel(c),
    instructions: spec.instructions,
    tools: spec.tools,
    stopWhen: spec.maxSteps == null ? (() => false) : isStepCount(spec.maxSteps),
    // Retries are the fetch wrapper's (languageModel/withRetry) — never the
    // SDK's fixed-doubling loop, and never both.
    maxRetries: 0,
    ...(reasoning ? { reasoning } : {}),
  });
}
export type Agent = ReturnType<typeof createAgent>;
