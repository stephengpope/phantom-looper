// The settings this app adds to the backend SDK's own — registered through
// the settings door; resolved, validated and shown exactly like the SDK's.
// Each belongs to a user-space feature: the looper's switches, the bot's
// behaviour, the cli's launch.
import type { SettingDefinition } from 'phantom-backend-sdk';

export const appSettings: SettingDefinition[] = [
  // ── the looper ────────────────────────────────────────────────────────
  { key: 'auto_plan', default: false, type: 'boolean', label: 'auto plan', group: 'looper',
    description: 'Start a planning run on every card that enters the plan column. A card may override it.' },
  { key: 'auto_build', default: false, type: 'boolean', label: 'auto build', group: 'looper',
    description: 'Start a build run on every card that enters in progress. A card may override it.' },
  { key: 'auto_push_on_archive', default: true, type: 'boolean', label: 'auto-push on archive', group: 'looper',
    description: "Archiving a done card auto-pushes its session's work to the base branch." },
  // ── the Telegram bot's behaviour ──────────────────────────────────────
  { key: 'telegram_reply_mode', default: 'text', type: 'string', choices: ['text', 'voice', 'both'], label: 'reply mode', group: 'chat',
    description: 'How the bot answers: text, a spoken voice note, or both. Read at the start of each turn.' },
  { key: 'telegram_transcript_echo', default: false, type: 'boolean', label: 'echo transcripts', group: 'chat',
    description: 'Send the heard text of a voice note back before answering it.' },
  { key: 'telegram_auto_build_notifications', default: true, type: 'boolean', label: 'build alerts', group: 'chat',
    description: 'A message when the looper moves a card to in progress, blocked, or done. Moves made by people are never announced.' },
  // ── the cli's launch ──────────────────────────────────────────────────
  { key: 'boot_last_project', default: true, type: 'boolean', label: 'boot into last project', group: 'sessions', projectOverridable: false,
    description: 'On, launching the cli skips the project picker and starts a session in the project you last drove yourself.' },
];
