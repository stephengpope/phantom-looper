// The settings this app adds to the backend SDK's own — registered through
// the settings door; resolved, validated and shown exactly like the SDK's.
// Each belongs to a user-space feature: the looper's switches, the bot's
// behaviour, the cli's voice pane and launch. `before` files one among the
// SDK's rows where it belongs on screen.
import type { SettingDefinition } from 'phantom-backend-sdk';

export const appSettings: SettingDefinition[] = [
  { key: "auto_plan", type: "boolean", default: false, label: "auto plan", group: "board",
    description: "Cards in plan are driven by the supervisor: it has the coding agent write a plan, verifies it, and moves the card to in progress. Each card's own Auto plan switch overrides this default.", projectOverridable: true, before: "card_prefix" },
  { key: "auto_build", type: "boolean", default: false, label: "auto build", group: "board",
    description: "Cards in progress are driven by the supervisor: it prompts the coding agent, verifies the work against the repo, and moves the card. Each card's own Auto build switch overrides this default.", projectOverridable: true, before: "card_prefix" },
  { key: "loop_budget_tokens", type: "number", default: null, label: "loop token budget", group: "board",
    description: "Maximum tokens one card run may spend — input + output summed across both agents' sessions; cache reads and writes not counted. Checked between turns; exceeding it blocks the card. Empty = no limit.", unit: "count", min: 1, projectOverridable: true, before: "card_prefix" },
  { key: "telegram_reply_mode", type: "string", default: "text", label: "reply mode", group: "telegram",
    description: "How the bot answers: text, voice (a spoken note, on the Assistant's Deepgram voice), or both. Read at the start of each turn.", choices: ["text", "voice", "both"], before: "session_digest_interval" },
  { key: "telegram_transcript_echo", type: "boolean", default: false, label: "transcript echo", group: "telegram",
    description: "On, a voice note's transcript is posted back as 🎤 \"…\" before the turn runs, so a misheard word is distinguishable from a misunderstood instruction.", before: "session_digest_interval" },
  { key: "telegram_auto_build_notifications", type: "boolean", default: true, label: "auto build alerts", group: "telegram",
    description: "A message when the loop moves a card to in progress, blocked, or done. Moves made by people are never announced. Reply to one to enter the card's coding session. Per project: override on the project.", projectOverridable: true, before: "session_digest_interval" },
  { key: "voice_enabled", type: "boolean", default: false, label: "enabled", group: "assistant",
    description: "Start the Assistant with the cli. It listens on the mic, answers out loud and in the voice pane (ctrl+g), and can act on the cli through its tools.", subgroup: "voice", before: "voice_spoken_voice" },
  { key: "sidebar_width", type: "number", default: 20, label: "voice pane width", group: "assistant",
    description: "Width of the voice pane as a percent of the terminal.", subgroup: "voice", unit: "count", min: 10, before: "voice_spoken_voice" },
  { key: "voice_wake_word", type: "boolean", default: false, label: "wake word only", group: "assistant",
    description: "On = the Assistant only answers when it hears one of the wake words (and for a few seconds after). Off = it answers everything it hears.", subgroup: "voice" },
  { key: "voice_wake_words", type: "string", default: "computer", label: "wake words", group: "assistant",
    description: "Words that address the Assistant when wake is on, comma-separated.", subgroup: "voice" },
  { key: "voice_wake_timeout", type: "number", default: 8, label: "wake timeout", group: "assistant",
    description: "Seconds of silence after the wake word before it is needed again. Any speech — yours or the Assistant's — restarts the clock.", subgroup: "voice", unit: "count", min: 1 },
  { key: "boot_last_project", type: "boolean", default: true, label: "boot into last project", group: "sessions",
    description: "On (the default), launching the cli skips the project picker: it starts a new session in the project of the most recent session you drove yourself (looper-run sessions do not count). Off, launching opens the picker. --resume is unaffected." },
];
