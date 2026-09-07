# core/llm/ — how an agent is built and recorded

Everything an agent is: its model handle, its retries, its prompt, its
transcript. The cli and the backend build the same four agents from these
parts, so nothing here knows which side is calling.

```
createAgent.ts   languageModel(cfg) — the provider switch, the OAuth disguise, withRetry, the thinking rule
                 createAgent(cfg, spec) — a ToolLoopAgent whose stream/generate take a `record` sink
                 withCacheBreakpoints(messages) — Anthropic cache marks on a copy of first + last message
agentConfig.ts   settings rows → ModelConfig: modelConfigFrom (coding), agentModelConfig (the cascade for
                 supervisor_* / assistant_*), buildCodingAgent, PROVIDER_KEY
transcript.ts    the JSONL format: Transcript (file-backed), parseTranscript / serializeTranscript,
                 memoryRecorder, usage events, dropDanglingToolCall, lastUserFromJsonl, sumUsageFromJsonl
agents/          coding · assistant · supervisor — one file each: <name>Instructions() + <name>Agent()
prompts/         the documents and their wiring — own map
tools/           the kits — own map
```

## Building an agent

`createAgent(ModelConfig, {instructions, tools, maxSteps})`. All three take
`tools` from the caller.
`maxSteps` null means unlimited, spelled out because the SDK default is 20.
The Assistant pins reasoning to `none`; the others inherit the setting.
Every agent gets `withCurrentDate` appended at build,
so the date is never in a frozen prompt.

Who calls the builders:

| builder | called from |
|---|---|
| `buildCodingAgent` | `phantom-backend/looper/turn.ts`, `phantom-cli/agentFromConfig.ts` |
| `assistantAgent` | `phantom-cli/agentFromConfig.ts`, `phantom-backend/telegram/assistant.ts` |
| `supervisorAgent` | `phantom-backend/looper/engine.ts` |
| `languageModel` alone | `phantom-backend/sessionTitle.ts`, `phantom-backend/git/commitMessage.ts` (one-shot generateText) |

## Model config

There is no default provider. An unset provider still builds: `languageModel`
returns a handle whose first call throws `NO_PROVIDER` with the fix in the
message, so a session opens on a bare server. The other agents' trios
resolve through `cascade`: a field inherits from the coding config only while
the provider matches; a cross-provider override requires its own model and
never inherits `base_url`. This throws at build, not at write, because the
settings store writes one key at a time and cannot see the pair.

## Retries and thinking

Retries are ours, in the fetch wrapper inside `languageModel`, and every SDK
call sets `maxRetries: 0`. Schedule `RETRY_WAITS_S`, budget `RETRY_BUDGET_MS`
(inside the session lock TTL on purpose). Retryable is 408/409/429/5xx and a
network `TypeError`; a non-string body is never replayed; giving up returns
the failing response so the SDK throws its own error.

`effectiveReasoning` turns `none` into `minimal` for Anthropic models that
cannot disable thinking (`thinkingAlwaysOn`). A Claude subscription token
(`isAnthropicOAuth`) is sent as Bearer with the Claude Code identity as the
first system block; `anthropicOAuthFetch` rewrites the body.

## The transcript

JSONL. Line 1 is the header (`type: 'session'`, agent, provider, model,
`system_prompt` frozen, extra fields welcome). Every line with a `role` is a
message. Any other line with a `type` is an event (`usage` after every step,
`interrupted` after an esc cut). `parseTranscript` skips a torn line, trims a
tool call with no result, and pins events by `at` (messages before it) so
`serializeTranscript` can put them back.

`record` is the one usage seam: pass a `Transcript` (file-backed) or
`memoryRecorder(startAt).record` to `agent.stream`, and each step's messages
plus a usage line land through `appendStep`. The step seam is used because
the SDK's turn-end `response.messages` carries only the final step.

## Cache marks

`withCacheBreakpoints` goes on at every conversation-shaped call site
(`phantom-cli/agent.ts`, `looper/turn.ts`, `looper/engine.ts`,
`telegram/assistant.ts`) and never into the stored history.

## Tested in

`test/llm.test.ts` (createAgent on a capturing fetch, the cascade, the
thinking rule, retries, the transcript format), `test/transcripts.test.ts`
(the server side of the record).
