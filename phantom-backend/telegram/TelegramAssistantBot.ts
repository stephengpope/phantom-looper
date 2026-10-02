// TelegramAssistantBot — how THIS bot behaves: assistant mode (the home it
// answers in) and code mode (a message is a turn on the active coding
// session), the slash commands, what it says, which looper moves become a
// DM. User space: the webhook, rendering, voice, approvals and dedupe are
// the SDK's (backend.telegramBot & co.); this is the handler they call.
// Stub: today's engine.ts, commands.ts, assistant.ts, assistantConversation.ts
// and alerts.ts move in when the SDK's objects are real.
import type { PhantomBackend } from 'phantom-backend-sdk';

export class TelegramAssistantBot {
  constructor(private readonly backend: PhantomBackend) {}
  /** Register the commands with Telegram, subscribe to updates and board events. */
  async start(): Promise<void> { throw stub(); }
  async stop(): Promise<void> { throw stub(); }
}
const stub = () => new Error('stub');
