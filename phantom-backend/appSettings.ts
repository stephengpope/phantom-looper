// The settings this app adds to the backend SDK's own — registered through
// the settings door; resolved, validated and shown exactly like the SDK's.
// Each belongs to a user-space feature: the looper's switches, the bot's
// behaviour, the cli's launch.
import type { SettingDefinition } from 'phantom-backend-sdk';

export const appSettings: SettingDefinition[] = [
  // ── the looper ────────────────────────────────────────────────────────
  { key: 'auto_plan', default: false, type: 'boolean', label: 'auto plan', group: 'board', projectOverridable: true,
    description: 'Start a planning run on every card that enters the plan column. A card may override it.' },
  { key: 'auto_build', default: false, type: 'boolean', label: 'auto build', group: 'board', projectOverridable: true,
    description: 'Start a build run on every card that enters in progress. A card may override it.' },
  { key: 'auto_push_on_archive', default: true, type: 'boolean', label: 'auto-push on archive', group: 'git', projectOverridable: true,
    description: "Archiving a done card auto-pushes its session's work to the base branch; a failed push un-archives the card into blocked. Archiving from any other column never pushes." },
  { key: 'loop_budget_tokens', default: null, type: 'number', label: 'loop token budget', group: 'board', unit: 'count', min: 1, projectOverridable: true,
    description: "Maximum tokens one card run may spend — input + output summed across both agents' sessions; cache reads and writes not counted. Checked between turns; exceeding it blocks the card. Empty = no limit." },
  // ── the Telegram bot's behaviour ──────────────────────────────────────
  { key: 'telegram_reply_mode', default: 'text', type: 'string', choices: ['text', 'voice', 'both'], label: 'reply mode', group: 'telegram',
    description: 'How the bot answers: text, a spoken voice note, or both. Read at the start of each turn.' },
  { key: 'telegram_transcript_echo', default: false, type: 'boolean', label: 'transcript echo', group: 'telegram',
    description: 'Send the heard text of a voice note back before answering it.' },
  { key: 'telegram_auto_build_notifications', default: true, type: 'boolean', label: 'auto build alerts', group: 'telegram', projectOverridable: true,
    description: 'A message when the looper moves a card to in progress, blocked, or done. Moves made by people are never announced.' },
  // ── the cli's voice pane — rendered by the cli, stored here so every cli you open is the same one ──
  { key: 'voice_enabled', default: false, type: 'boolean', label: 'enabled', group: 'assistant', subgroup: 'voice',
    description: 'Start the Assistant with the cli. It listens on the mic, answers out loud and in the voice pane (ctrl+g), and can act on the cli through its tools.' },
  { key: 'sidebar_width', default: 20, type: 'number', label: 'voice pane width', group: 'assistant', subgroup: 'voice', unit: 'count', min: 10,
    description: 'Width of the voice pane as a percent of the terminal.' },
  { key: 'voice_wake_word', default: false, type: 'boolean', label: 'wake word only', group: 'assistant', subgroup: 'voice',
    description: 'On = the Assistant only answers when it hears one of the wake words (and for a few seconds after). Off = it answers everything it hears.' },
  { key: 'voice_wake_words', default: 'computer', type: 'string', label: 'wake words', group: 'assistant', subgroup: 'voice',
    description: 'Words that address the Assistant when wake is on, comma-separated.' },
  { key: 'voice_wake_timeout', default: 8, type: 'number', label: 'wake timeout', group: 'assistant', subgroup: 'voice', unit: 'count', min: 1,
    description: "Seconds of silence after the wake word before it is needed again. Any speech — yours or the Assistant's — restarts the clock." },
  // ── the cli's launch ──────────────────────────────────────────────────
  { key: 'boot_last_project', default: true, type: 'boolean', label: 'boot into last project', group: 'sessions', projectOverridable: false,
    description: 'On, launching the cli skips the project picker and starts a session in the project you last drove yourself.' },
];
