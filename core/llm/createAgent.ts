// The one place an LLM agent is assembled. Every caller — the server's Git
// Fixer, the TUI's coding agent, the TUI's Assistant, the example agent —
// builds its agent here and then talks to it with the AI SDK's own
// methods (`agent.stream()`, `agent.generate()`). Nothing else in the tree
// constructs a provider client.
//
// What lives here, so it is fixed once:
// - the provider switch (anthropic | openai | openai-codex | google |
//   deepseek | kimi | openai-compatible) — provider packages only, no
//   gateway;
// - the Anthropic subscription-token disguise (OAuth tokens authenticate with
//   Bearer, carry the Claude Code CLI headers, and need the Claude Code
//   identity as the first system block) — see `anthropicProvider`;
// - the thinking rule: the AI SDK maps `reasoning: 'none'` to
//   `thinking: disabled`, which Claude Fable rejects with a 400 (thinking
//   cannot be turned off on that model; verified live 2026-08-23). Here
//   'none' becomes 'minimal' (adaptive thinking at effort "low") for that
//   family and stays 'none' (no thinking at all) for every other model —
//   on haiku-4-5, 'minimal' would switch thinking ON.
import { ToolLoopAgent, isStepCount, wrapLanguageModel, type LanguageModel, type LanguageModelMiddleware,
  type ModelMessage, type SystemModelMessage, type Tool } from 'ai';
import type { LanguageModelV4Usage } from '@ai-sdk/provider';
import type { StepRecord } from './transcript.js';
import type { NudgeQueue } from './nudgeQueue.js';
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

export const PROVIDERS = ['anthropic', 'openai', 'openai-codex', 'google', 'deepseek', 'kimi', 'xai', 'mistral', 'groq', 'openai-compatible'] as const;
export type Provider = typeof PROVIDERS[number];
export const REASONINGS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type Reasoning = typeof REASONINGS[number];

// ── token recording ───────────────────────────────────────────────────────
// Every model handle in the tree is built by `languageModel()` below, and
// every one is wrapped so that every call — an agent step, a one-shot
// generateText, anything — records its usage here. There is no way to call
// a model without going through this, so there is nothing to forget.
// The sink is set once at boot: the server writes the log_tokens table
// directly (LogTokens.record); the CLI posts to the server, which does the
// same. Null (tests, before boot) = calls run, nothing is recorded.

/** What a call is billed to — the session it serves and what kind of work.
 *  Kinds come in two groups, and the class name says which: agents
 *  (`CodingAgent`) run tool loops for the user; helpers (`TitleHelper`) are
 *  one-shot calls the system makes for itself. */
export const AGENT_KINDS = ['coding', 'supervisor', 'assistant'] as const;
export const HELPER_KINDS = ['title', 'commit_message', 'compaction', 'session_digest'] as const;
export type AgentKind = typeof AGENT_KINDS[number];
export type HelperKind = typeof HELPER_KINDS[number];
export type TokenKind = AgentKind | HelperKind;
export type TokenGroup = 'agent' | 'helper';
export interface TokenUsageContext { kind: TokenKind; sessionId?: string | null }

export interface TokenRecord extends TokenUsageContext {
  provider: string; model: string; responseId?: string;
  input: number; output: number; cacheRead: number; cacheWrite: number;
}
let _tokenRecorder: ((r: TokenRecord) => void) | null = null;
/** The one sink. Called once at server / CLI boot. */
export function setTokenRecorder(fn: (r: TokenRecord) => void): void { _tokenRecorder = fn; }

/** The middleware that does the recording — one per model handle. Usage is
 *  read where the SDK reads it: the generate result, or the stream's `finish`
 *  part; the response id from the result / the `response-metadata` part. */
function recordUsage(c: ModelConfig): LanguageModelMiddleware {
  const emit = (u: LanguageModelV4Usage, responseId?: string) => {
    if (!_tokenRecorder || !c.usage) return;
    _tokenRecorder({
      ...c.usage, provider: c.provider, model: c.model, responseId,
      input: u.inputTokens.total ?? 0, output: u.outputTokens.total ?? 0,
      cacheRead: u.inputTokens.cacheRead ?? 0, cacheWrite: u.inputTokens.cacheWrite ?? 0,
    });
  };
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

export interface ModelConfig {
  provider: Provider;
  model: string;
  baseUrl?: string | null;
  apiKey?: string | null;
  /** What this model's calls are billed to. Filled in from the class name by
   *  PhantomAgent and PhantomHelper — the only two callers of languageModel.
   *  Absent = not recorded. */
  usage?: TokenUsageContext;
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

/** Which group a kind belongs to. Unknown kinds (a row written by an older
 *  build) count as helpers so a report never drops them. */
export function groupOf(kind: string): TokenGroup {
  return (AGENT_KINDS as readonly string[]).includes(kind) ? 'agent' : 'helper';
}

/** A class's billing kind, read off its name: CodingAgent → 'coding',
 *  CommitMessageHelper → 'commit_message'. Throws at construction when the
 *  name is not a TokenKind, or its suffix disagrees with the kind's group,
 *  so a misnamed agent or helper cannot run unbilled or land in the wrong
 *  column of the report. */
export function kindOf(className: string): TokenKind {
  const suffix = className.endsWith('Agent') ? 'agent' : className.endsWith('Helper') ? 'helper' : null;
  const kind = className.replace(/(Agent|Helper)$/, '').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const known = ([...AGENT_KINDS, ...HELPER_KINDS] as readonly string[]).includes(kind);
  if (!known || suffix !== groupOf(kind)) {
    throw new Error(`${className}: "${kind}" is not a TokenKind — name the class <Kind>Agent with Kind in AGENT_KINDS, or <Kind>Helper with Kind in HELPER_KINDS`);
  }
  return kind as TokenKind;
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
  return createAnthropic({ apiKey: keyFor(c), fetch: c.fetch });
}

// --- OpenAI Codex (ChatGPT subscription) ------------------------------------------

/** OpenAI Codex: uses the ChatGPT OAuth token from ~/.codex/auth.json (written
 *  by `codex login`) to hit the Codex Responses API at chatgpt.com. The
 *  @openai-oauth/core transport handles token refresh, Codex headers, and the
 *  Responses wire protocol; we feed it to the standard @ai-sdk/openai provider
 *  the same way the openai-oauth-provider package does. No API key setting
 *  needed — credentials live in the file.
 *
 *  When ~/.codex/auth.json is missing or has no valid token, the library throws
 *  on the first request. We catch that in a fetch wrapper and rethrow with a
 *  message that names the fix (`npx @openai/codex login`). */
function openaiCodexModel(c: ModelConfig): Exclude<LanguageModel, string> {
  const creds = openaiCredentials();
  const transport = createOpenAIOAuthTransport({
    auth: () => creds.getSession().catch(() => {
      throw new Error(
        'openai-codex: no valid ChatGPT credentials found — run `npx @openai/codex login` ' +
        'to sign in, then try again (credentials are stored in ~/.codex/auth.json)',
      );
    }),
    baseURL: creds.baseURL,
    fetch: c.fetch,
  });
  return createOpenAI({
    apiKey: 'openai-oauth',
    baseURL: transport.baseURL,
    fetch: transport.fetch,
  }).responses(c.model);
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
  // Nothing chosen yet: the agent still BUILDS (a session opens, the banner
  // draws), and the first call fails with the fix in the message. There is no
  // default provider — see phantom-backend/settings.ts.
  if (!c.provider) return unsetModel(NO_PROVIDER);
  if (!c.model) return unsetModel(`no model set for ${c.provider} — ${PICK_MODEL}`);
  return wrapLanguageModel({ model: providerModel(c), middleware: recordUsage(c) });
}

/** The key for a keyed provider, or a refusal (openai-codex reads its own
 *  login file; an openai-compatible endpoint may be open — neither asks). Never `undefined`: every SDK
 *  client falls back to an environment variable when handed none, and a key
 *  that came from the environment is a key nobody set in /keys — a second
 *  source of truth. The settings layer names the fix; this is the backstop. */
function keyFor(c: ModelConfig): string {
  if (c.apiKey) return c.apiKey;
  throw new Error(`no API key for provider ${c.provider} — set its key on /keys (phantom-cli)`);
}

function providerModel(c: ModelConfig): Exclude<LanguageModel, string> {
  switch (c.provider) {
    case 'anthropic': return anthropicProvider(c)(c.model);
    case 'openai': return createOpenAI({ apiKey: keyFor(c), baseURL: c.baseUrl ?? undefined, fetch: c.fetch })(c.model);
    case 'openai-codex': return openaiCodexModel(c);
    case 'google': return createGoogleGenerativeAI({ apiKey: keyFor(c), fetch: c.fetch })(c.model);
    case 'deepseek': return createDeepSeek({ apiKey: keyFor(c), baseURL: c.baseUrl ?? undefined, fetch: c.fetch })(c.model);
    case 'kimi': return createMoonshotAI({ apiKey: keyFor(c), baseURL: c.baseUrl ?? undefined, fetch: c.fetch })(c.model);
    case 'xai': return createXai({ apiKey: keyFor(c), baseURL: c.baseUrl ?? undefined, fetch: c.fetch }).chat(c.model);
    case 'mistral': return createMistral({ apiKey: keyFor(c), baseURL: c.baseUrl ?? undefined, fetch: c.fetch })(c.model);
    case 'groq': return createGroq({ apiKey: keyFor(c), baseURL: c.baseUrl ?? undefined, fetch: c.fetch })(c.model);
    case 'openai-compatible':
      if (!c.baseUrl) throw new Error(`provider is openai-compatible but no endpoint is set — set it on /settings (phantom-cli)`);
      return createOpenAICompatible({ name: 'phantom-looper', baseURL: c.baseUrl, apiKey: c.apiKey ?? 'none', fetch: c.fetch })(c.model);
    default: throw new Error(`provider "${String((c as { provider: string }).provider)}" is not one of ${PROVIDERS.join(', ')} — ${PICK_MODEL}`);
  }
}

const PICK_MODEL = 'pick one on /settings (phantom-cli)';
export const NO_PROVIDER = `no provider set — ${PICK_MODEL}`;

/** A model handle that fails every call with `reason`. */
function unsetModel(reason: string): Exclude<LanguageModel, string> {
  const fail = async (): Promise<never> => { throw new Error(reason); };
  return { specificationVersion: 'v3', provider: 'none', modelId: '', supportedUrls: {}, doGenerate: fail, doStream: fail };
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
        // scripted transport) are not transient and rethrow untouched.
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
 * Prompt caching — three breakpoints, three cache lifetimes:
 *
 *  1. Static system block — identical across every workspace and session.
 *     Set on the first SystemModelMessage in the instructions array, by the
 *     agent builder (e.g. codingAgent's splitInstructions). Cached globally.
 *  2. Workspace system block — per-workspace (skills, secrets, credentials,
 *     current date). Set on the second SystemModelMessage.
 *     Cached across sessions in the same workspace.
 *  3. Last conversation message — the rolling mark placed here by
 *     withCacheBreakpoints, before every step. The backward walk from it
 *     finds the best prior prefix (the previous step's write, or on a new
 *     session the workspace block's write).
 *
 * Anthropic: explicit breakpoints, 4 max — we use 3. The backward walk
 * (20-block lookback per breakpoint) finds prior writes automatically.
 * OpenAI / Gemini: cache automatically, ignore the anthropic provider
 * options.
 *
 * The marks go on copies: history is what we persist and replay, and it
 * stays clean. This runs before EVERY step (createAgent's prepareStep),
 * not once per turn — Anthropic only looks ~20 content blocks back from a
 * breakpoint, so a mark left where the turn started goes stale once the
 * tool loop grows past that. Re-marking each step keeps the rolling
 * breakpoint within a block or two of the end.
 *
 * Re-marking means messages may already carry a mark from a prior step
 * (overrides carry forward), and Anthropic caps at 4 breakpoints — so
 * every stale mark comes off first.
 */
const unmark = (m: ModelMessage): ModelMessage => {
  // Nothing else in the tree writes a message's anthropic provider options,
  // so the whole block is ours to drop.
  if (!m.providerOptions?.anthropic) return m;
  const { anthropic: _stale, ...rest } = m.providerOptions;
  return Object.keys(rest).length ? { ...m, providerOptions: rest }
    : (({ providerOptions: _drop, ...bare }) => bare as ModelMessage)(m);
};

/** How long Anthropic keeps a cached prefix alive. The default is 5 minutes,
 *  which a person driving the cli outlasts every time they step away — six
 *  full expiries in the session measured above, each one re-writing ~1M tokens
 *  from scratch. An hour costs 2x the write rate instead of 1.25x, but a write
 *  is only ever the delta past the last breakpoint (a few hundred tokens once
 *  the prefix is warm), so the premium is paid on scraps and the saved
 *  re-writes are the whole conversation. */
export const CACHE_TTL = '1h';

const mark = (m: ModelMessage): ModelMessage => ({
  ...m,
  providerOptions: {
    ...m.providerOptions,
    anthropic: { cacheControl: { type: 'ephemeral', ttl: CACHE_TTL } },
  },
});

export function withCacheBreakpoints(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  const out = messages.map(unmark);
  // Only the last message gets a rolling breakpoint — the system prompt blocks
  // carry their own breakpoints (set in the instructions array), and the
  // backward walk from this mark finds the best prior prefix automatically.
  out[out.length - 1] = mark(out[out.length - 1]);
  return out;
}

export interface AgentSpec {
  /** The system prompt — a single string, or an array of SystemModelMessages
   *  for per-block cache control (static block + workspace block). */
  instructions: string | SystemModelMessage[];
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
 *  re-implements the bookkeeping.
 *
 *  `nudgeQueue` is the nudge seam: a NudgeQueue whose `drain()` is called
 *  before every model call. Ready entries are pulled out and appended to
 *  that call's messages — a typed word (or transcribed voice note) reaches
 *  the very next LLM call mid-turn. The queue's own `onDrain` callback
 *  fires so the caller can mirror the texts into its own history and
 *  screen. Whatever is still queued when the turn ends (typed during
 *  the final answer — there is no next call to ride) is the caller's to
 *  run as the next turn. A per-call prepareStep REPLACES the constructor's
 *  (ToolLoopAgent merges call options over settings), so the cache marks
 *  are re-applied here rather than assumed. */
function spliceTurn<T extends { onStepEnd?: (step: never) => unknown }>(
  o: T & { record?: StepRecord; nudgeQueue?: NudgeQueue },
): T {
  const { record, nudgeQueue, ...rest } = o;
  let out = rest as T;
  if (record) {
    const prior = out.onStepEnd as ((step: unknown) => unknown) | undefined;
    out = {
      ...out,
      onStepEnd: (step: { response: { messages: unknown[]; id?: string }; usage?: unknown }) => {
        record.appendStep(step.response.messages as ModelMessage[],
          step.usage as Parameters<StepRecord['appendStep']>[1]);
        // Step-level transcript save — best-effort, never blocks.
        record.onStepSaved?.();
        return prior?.(step);
      },
    } as unknown as T;
  }
  if (nudgeQueue) {
    out = {
      ...out,
      prepareStep: ({ messages }: { messages: ModelMessage[] }) => {
        const nudges = nudgeQueue.drain();
        if (nudges.length) {
          const userMessages = nudges.map((content) => ({ role: 'user', content }) as ModelMessage);
          record?.appendStep(userMessages);
          return { messages: withCacheBreakpoints([...messages, ...userMessages]) };
        }
        return { messages: withCacheBreakpoints(messages) };
      },
    } as unknown as T;
  }
  return out;
}

/** The base of every agent. A subclass is named for what it is —
 *  `class CodingAgent extends PhantomAgent` — and that name, read here at
 *  construction, is what its every model call is billed to (kindOf). There
 *  is nothing else to declare: no kind field, no registration.
 *
 *  Talk to it with the AI SDK's own `agent.stream({messages, abortSignal,
 *  onStepEnd})` / `agent.generate({prompt, abortSignal})` — plus the
 *  `record` and `nudgeQueue` options (spliceTurn, above) on either. */
export abstract class PhantomAgent extends ToolLoopAgent<never, Record<string, Tool>> {
  constructor(c: ModelConfig, sessionId: string | null, spec: AgentSpec) {
    const reasoning = effectiveReasoning(c.provider, c.model, c.reasoning);
    super({
      model: languageModel({ ...c, usage: { kind: kindOf(new.target.name), sessionId } }),
      instructions: spec.instructions,
      tools: spec.tools,
      stopWhen: spec.maxSteps == null ? (() => false) : isStepCount(spec.maxSteps),
      // The cache marks, re-placed before every step — see withCacheBreakpoints
      // for why once per turn is not enough. This is the only place they are
      // applied; callers hand `stream`/`generate` their clean history.
      prepareStep: ({ messages }) => ({ messages: withCacheBreakpoints(messages) }),
      // Retries are the fetch wrapper's (languageModel/withRetry) — never the
      // SDK's fixed-doubling loop, and never both.
      maxRetries: 0,
      ...(reasoning ? { reasoning } : {}),
    });
  }
  override stream(o: Parameters<ToolLoopAgent<never, Record<string, Tool>>['stream']>[0] &
    { record?: StepRecord; nudgeQueue?: NudgeQueue }) {
    return super.stream(spliceTurn(o));
  }
  override generate(o: Parameters<ToolLoopAgent<never, Record<string, Tool>>['generate']>[0] &
    { record?: StepRecord; nudgeQueue?: NudgeQueue }) {
    return super.generate(spliceTurn(o));
  }
}
export type Agent = PhantomAgent;
