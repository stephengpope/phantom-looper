// What this app is made of: the config phantom-backend hands the backend
// SDK. Nothing here but the registrations and what to start. The SDK owns
// boot, the services, the API; this app owns the looper, the three agents,
// the bot's behaviour.
import type { PhantomBackendConfig } from 'phantom-backend-sdk';
import { appSettings } from './appSettings.js';
import { appAgentTypes } from './appAgentTypes.js';
import { menuFor } from './telegram/commands.js';
import { LOOPER_STARTER } from './looper/engine.js';
import { CRON_STARTER } from './crons/engine.js';

export const config: PhantomBackendConfig = {
  settings: appSettings,
  agentTypes: appAgentTypes,
  // The engines that open sessions for themselves; a default list leaves those out.
  backgroundStarters: [LOOPER_STARTER, CRON_STARTER],
  // tools and routes: registered in index.ts, where their wiring still lives (plan §5, §7).
  // The bot's command menu — the global default, and the authorized chat's for its mode.
  telegramCommandMenu: async (state) => ({ global: menuFor('assistant'), forChat: menuFor(state.mode) }),
  // onStart / onStop: the looper, the cron scheduler, the Telegram bot and the
  // digest are still wired in index.ts around the backend (plan §5, §7); they
  // move here as each lands on the client SDK.
};
