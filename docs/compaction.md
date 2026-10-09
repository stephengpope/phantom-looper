# Compaction

The one open item. Parked; nothing triggers it today.

## What exists

- The settings, per agent type, in `storage/sdkSettings.ts`: `context_window`,
  `compact_threshold_pct`, `compact_strategy` (`fast`), `compact_summarize_pct`,
  `compact_max_tokens`. They cascade like every other setting.
- `AgentConfig.compactionFor(type, scope, pin)` resolves them for the model
  the type runs.
- The record has a line type for it (`compaction`, beside
  `system_prompt_rebuilt` in `GET /sessions/:id/transcript`); the token log
  bills a helper type `compaction`.
- `/compact` in the cli answers "not built yet" (`phantom-cli/window.ts`).

## What to build

Backend-side, on the record, under the session's hold: when the context
passes `compact_threshold_pct` of `context_window`, summarize the oldest
`compact_summarize_pct` of the conversation with the type's model, capped at
`compact_max_tokens`, and write one `compaction` line the same shape as
`system_prompt_rebuilt`. The next turn reads from that line. `/compact` runs
the same thing by hand.

Nothing else moves or is redesigned with it.
